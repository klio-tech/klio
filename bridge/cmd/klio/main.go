// Command klio is the Klio daemon + CLI.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/klio-tech/bridge/internal/bootstrap"
	"github.com/klio-tech/bridge/internal/config"
	"github.com/klio-tech/bridge/internal/daemon"
	"github.com/klio-tech/bridge/internal/hooks"
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
	case "init":
		runInit(os.Args[2:])
	case "uninstall":
		runUninstall(os.Args[2:])
	case "hook":
		runHook(os.Args[2:])
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

func runInit(args []string) {
	flags := flag.NewFlagSet("init", flag.ExitOnError)
	cloudURL := flags.String("cloud", os.Getenv("KLIO_API_URL"), "Klio cloud URL")
	email := flags.String("email", "", "optional email for eager claim")
	mcpBin := flags.String(
		"mcp-bin", "", "absolute path to klio-mcp binary (defaults to lookup on PATH)",
	)
	_ = flags.Parse(args)

	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "config error:", err)
		os.Exit(1)
	}
	if *cloudURL == "" {
		*cloudURL = cfg.CloudURL
	}
	if *mcpBin == "" {
		if path, _ := exec.LookPath("klio-mcp"); path != "" {
			*mcpBin = path
		} else {
			// Fall back to sibling of the running klio binary.
			exe, _ := os.Executable()
			*mcpBin = filepath.Join(filepath.Dir(exe), "klio-mcp")
		}
	}
	if _, err := config.EnsureKlioDir(); err != nil {
		fmt.Fprintln(os.Stderr, "ensure ~/.klio:", err)
		os.Exit(1)
	}

	keys := buildKeychain()
	report, err := bootstrap.Run(context.Background(), bootstrap.Options{
		CloudURL:      *cloudURL,
		KlioMcpBinary: *mcpBin,
		Keychain:      keys,
		Email:         *email,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "klio init failed:", err)
		os.Exit(1)
	}
	fmt.Println("Klio is set up.")
	fmt.Printf("  user_id:           %s\n", report.UserID)
	fmt.Printf("  agent_id:          %s\n", report.AgentID)
	fmt.Printf("  default_space_id:  %s\n", report.DefaultSpaceID)
	if len(report.AgentsConfigured) > 0 {
		fmt.Printf("  configured agents: %v\n", report.AgentsConfigured)
	} else {
		fmt.Println("  no agents detected (you can install Claude Code or Cursor first, then re-run klio init)")
	}
	if len(report.AgentsErrored) > 0 {
		fmt.Printf("  agents with errors: %v\n", report.AgentsErrored)
	}
	fmt.Println()
	fmt.Println("Start the daemon: klio daemon")
}

func runUninstall(args []string) {
	flags := flag.NewFlagSet("uninstall", flag.ExitOnError)
	purge := flags.Bool("purge", false, "also delete the cloud account (irreversible)")
	_ = flags.Parse(args)

	if *purge {
		fmt.Fprintln(os.Stderr, "(--purge not yet implemented; this will only revert local config + creds)")
	}
	keys := buildKeychain()
	if err := bootstrap.Uninstall(context.Background(), keys); err != nil {
		fmt.Fprintln(os.Stderr, "uninstall failed:", err)
		os.Exit(1)
	}
	fmt.Println("Klio uninstalled. Agent configs restored from .klio-backup files.")
}

func runHook(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: klio hook <event>")
		os.Exit(2)
	}
	backend := hooks.NewSocketBackend()
	exit := hooks.Run(args[0], backend, os.Stdin, os.Stdout, os.Stderr)
	os.Exit(exit)
}

func printUsage() {
	fmt.Fprintln(os.Stderr, "usage: klio [version|daemon|status|init|uninstall|hook]")
}
