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
	"strings"
	"syscall"

	"github.com/google/uuid"

	"github.com/klio-tech/bridge/internal/backfill"
	"github.com/klio-tech/bridge/internal/bootstrap"
	"github.com/klio-tech/bridge/internal/cloud"
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
	case "backfill":
		runBackfill(os.Args[2:])
	case "reembed":
		runReembed(os.Args[2:])
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

func runReembed(args []string) {
	flags := flag.NewFlagSet("reembed", flag.ExitOnError)
	spaceArg := flags.String("space", "",
		"space to re-embed (UUID, or 'default' to pick the only/default space)")
	toModel := flags.String("to", "",
		"target embedding model name (e.g. ollama/snowflake-arctic-embed2)")
	confirm := flags.Bool("confirm", false, "skip the interactive 'proceed?' prompt")
	_ = flags.Parse(args)

	if *toModel == "" {
		fmt.Fprintln(os.Stderr, "usage: klio reembed --space <id|default> --to <model>")
		os.Exit(2)
	}

	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "config:", err)
		os.Exit(1)
	}
	keys := buildKeychain()
	rt, err := keys.Get("refresh_token")
	if err != nil || len(rt) == 0 {
		fmt.Fprintln(os.Stderr, "no Klio credentials found — run `klio init` first")
		os.Exit(1)
	}

	ctx := context.Background()
	c := cloud.NewClient(cfg.CloudURL)
	c.SetRefreshToken(string(rt))
	if err := c.Refresh(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "refresh failed:", err)
		os.Exit(1)
	}
	_ = keys.Set("refresh_token", []byte(c.RefreshToken()))

	spaceID, err := resolveSpace(ctx, c, *spaceArg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "resolve space:", err)
		os.Exit(1)
	}

	if !*confirm {
		fmt.Printf(
			"About to re-embed every entry in space %s under %q.\n"+
				"This is irreversible — the previous embeddings are dropped.\n"+
				"Proceed? [y/N]: ", spaceID, *toModel,
		)
		var resp string
		_, _ = fmt.Scanln(&resp)
		if !strings.EqualFold(resp, "y") {
			fmt.Println("Aborted.")
			return
		}
	}

	resp, err := c.ReembedSpace(ctx, spaceID, *toModel)
	if err != nil {
		fmt.Fprintln(os.Stderr, "reembed failed:", err)
		os.Exit(1)
	}
	fmt.Printf(
		"Re-embedded space %s\n  from: %s (dim=%d)\n  to:   %s (dim=%d)\n  entries processed: %d\n",
		resp.SpaceID, resp.FromModel, resp.FromDim, resp.ToModel, resp.ToDim, resp.EntriesProcessed,
	)
}

// resolveSpace converts a user-provided space arg into a UUID. Accepts
// either a literal UUID or the keyword "default" (returns the user's
// only space, or fails clearly if there are multiple).
func resolveSpace(ctx context.Context, c *cloud.Client, arg string) (uuid.UUID, error) {
	if arg == "" || arg == "default" {
		spaces, err := c.ListSpaces(ctx)
		if err != nil {
			return uuid.Nil, fmt.Errorf("list spaces: %w", err)
		}
		if len(spaces) == 0 {
			return uuid.Nil, fmt.Errorf("no spaces found for this account")
		}
		if arg == "default" {
			for _, s := range spaces {
				if s.Slug == "default" {
					return s.ID, nil
				}
			}
		}
		if len(spaces) == 1 {
			return spaces[0].ID, nil
		}
		return uuid.Nil, fmt.Errorf(
			"multiple spaces exist; pass --space <uuid> explicitly. Found: %v",
			spaceSlugs(spaces),
		)
	}
	id, err := uuid.Parse(arg)
	if err != nil {
		return uuid.Nil, fmt.Errorf("--space must be UUID or 'default': %w", err)
	}
	return id, nil
}

func spaceSlugs(spaces []cloud.Space) []string {
	out := make([]string, len(spaces))
	for i, s := range spaces {
		out[i] = fmt.Sprintf("%s (%s)", s.Slug, s.ID)
	}
	return out
}

func runBackfill(args []string) {
	flags := flag.NewFlagSet("backfill", flag.ExitOnError)
	defaultRoot := func() string {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, ".claude", "projects")
	}()
	root := flags.String("root", defaultRoot, "directory of session JSONL files")
	confirm := flags.Bool("confirm", false, "skip the interactive 'proceed?' prompt")
	maxParallel := flags.Int("parallel", 4, "max concurrent sessions to process")
	_ = flags.Parse(args)

	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "config:", err)
		os.Exit(1)
	}
	keys := buildKeychain()

	rt, err := keys.Get("refresh_token")
	if err != nil || len(rt) == 0 {
		fmt.Fprintln(os.Stderr, "no Klio credentials found — run `klio init` first")
		os.Exit(1)
	}

	ctx := context.Background()

	// Mint a fresh access token via /v1/tokens/refresh.
	c := cloud.NewClient(cfg.CloudURL)
	c.SetRefreshToken(string(rt))
	if err := c.Refresh(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "refresh failed:", err)
		os.Exit(1)
	}
	// Persist the rotated refresh token so daemons see it on next start.
	_ = keys.Set("refresh_token", []byte(c.RefreshToken()))

	// Walk + cost preview.
	projects, err := backfill.Walk(*root)
	if err != nil {
		fmt.Fprintln(os.Stderr, "walk:", err)
		os.Exit(1)
	}
	sessionCount := 0
	totalBytes := int64(0)
	for _, p := range projects {
		for _, s := range p.Sessions {
			info, err := os.Stat(s.Path)
			if err != nil {
				continue
			}
			sessionCount++
			totalBytes += info.Size()
		}
	}
	fmt.Printf("Found %d sessions across %d projects (~%.1f MB).\n",
		sessionCount, len(projects), float64(totalBytes)/(1024*1024))
	if sessionCount == 0 {
		fmt.Println("Nothing to do.")
		return
	}
	if !*confirm {
		fmt.Print("Proceed? [y/N]: ")
		var resp string
		_, _ = fmt.Scanln(&resp)
		if !strings.EqualFold(resp, "y") {
			fmt.Println("Aborted.")
			return
		}
	}

	cpPath := filepath.Join(filepath.Dir(cfg.CacheDBPath), "backfill-checkpoint.json")
	cp := backfill.NewCheckpoint(cpPath)

	client := backfill.NewHTTPClient(cfg.CloudURL, c.AccessToken())
	report, err := backfill.Run(ctx, backfill.Options{
		Root: *root, Client: client, Checkpoint: cp, MaxConcurrency: *maxParallel,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "backfill ended with %d errors:\n", len(report.Errors))
		for _, e := range report.Errors[:min(len(report.Errors), 10)] {
			fmt.Fprintln(os.Stderr, "  -", e)
		}
	}
	fmt.Printf(
		"Processed %d sessions, skipped %d (already done), failed %d.\n",
		report.ProcessedSessions, report.SkippedSessions, report.FailedSessions,
	)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func printUsage() {
	fmt.Fprintln(os.Stderr,
		"usage: klio [version|daemon|status|init|uninstall|hook|backfill|reembed]")
}
