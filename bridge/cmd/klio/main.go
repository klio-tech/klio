// Command klio is the Klio daemon + CLI.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/klio-tech/bridge/internal/config"
	"github.com/klio-tech/bridge/internal/daemon"
	"github.com/klio-tech/bridge/internal/keychain"
	"github.com/klio-tech/bridge/internal/version"
)

const keychainService = "tech.klio.bridge"

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "version", "--version", "-v":
		fmt.Println(version.Get())
	case "daemon":
		runDaemon()
	case "status":
		runStatus()
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand: %s\n", os.Args[1])
		printUsage()
		os.Exit(2)
	}
}

func runDaemon() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("config load failed", "err", err)
		os.Exit(1)
	}
	if _, err := config.EnsureKlioDir(); err != nil {
		slog.Error("klio dir", "err", err)
		os.Exit(1)
	}
	keys := buildKeychain()

	d, err := daemon.New(cfg, keys)
	if err != nil {
		slog.Error("daemon init failed", "err", err)
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	slog.Info("klio-bridge running", "socket", cfg.SocketPath, "cloud", cfg.CloudURL)
	if err := d.Run(ctx); err != nil && err != context.Canceled {
		slog.Error("daemon run failed", "err", err)
		os.Exit(1)
	}
}

func runStatus() {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "config error:", err)
		os.Exit(1)
	}
	keys := buildKeychain()
	rt, _ := keys.Get("refresh_token")
	uid, _ := keys.Get("user_id")
	aid, _ := keys.Get("agent_id")

	out := map[string]any{
		"version":     version.Get(),
		"socket_path": cfg.SocketPath,
		"cloud_url":   cfg.CloudURL,
		"local_only":  cfg.LocalOnly,
		"has_creds":   len(rt) > 0,
		"user_id":     string(uid),
		"agent_id":    string(aid),
	}
	body, _ := json.MarshalIndent(out, "", "  ")
	fmt.Println(string(body))
}

func buildKeychain() keychain.Backend {
	home, _ := os.UserHomeDir()
	// KLIO_USE_FILE_KEYCHAIN=1 forces the file backend. Useful in CI,
	// non-interactive shells on macOS (where unsigned binaries trigger a
	// blocking Keychain permission prompt), and headless Linux containers
	// without a secret-service.
	if os.Getenv("KLIO_USE_FILE_KEYCHAIN") == "" {
		osKey := keychain.New(keychainService)
		if err := osKey.Set(".probe", []byte("ok")); err == nil {
			_ = osKey.Delete(".probe")
			return osKey
		}
	}
	master := sha256.Sum256([]byte(home + ":klio-bridge:fallback"))
	return keychain.NewFileBackend(
		filepath.Join(home, ".klio", "credentials.enc"),
		master[:],
	)
}

func printUsage() {
	fmt.Fprintln(os.Stderr, "usage: klio [version|daemon|status]")
}
