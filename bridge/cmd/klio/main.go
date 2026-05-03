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
	"time"

	"github.com/google/uuid"

	"github.com/klio-tech/bridge/internal/backfill"
	"github.com/klio-tech/bridge/internal/bootstrap"
	"github.com/klio-tech/bridge/internal/cloud"
	"github.com/klio-tech/bridge/internal/config"
	"github.com/klio-tech/bridge/internal/daemon"
	"github.com/klio-tech/bridge/internal/hooks"
	"github.com/klio-tech/bridge/internal/keychain"
	"github.com/klio-tech/bridge/internal/orchestrator"
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
	klioBin := flags.String(
		"klio-bin", "", "absolute path to klio binary (defaults to the running binary)",
	)
	mcpBin := flags.String(
		"mcp-bin", "", "absolute path to klio-mcp binary (defaults to sibling of klio)",
	)
	skipEnvFile := flags.Bool(
		"no-env-file", false,
		"do not write the local-dev env file (~/.klio/local-dev.env + ./.env)",
	)
	skipStack := flags.Bool(
		"no-stack", false,
		"skip docker preflight + compose up + ollama + engine wait (provision + agent wiring only)",
	)
	engineURL := flags.String(
		"engine-url", "http://127.0.0.1:8000",
		"engine URL to wait for after `docker compose up`",
	)
	embedModel := flags.String(
		"embedding-model", "nomic-embed-text",
		"Ollama embedding model to ensure is pulled (set empty to skip)",
	)
	engineTimeout := flags.Duration(
		"engine-timeout", 90*time.Second,
		"how long to wait for the engine /health endpoint after compose up",
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

	// Resolve klio binary path. Prefer the explicit flag, then the
	// running binary's own path (so `/tmp/klio init` writes
	// `/tmp/klio hook ...` into settings.json correctly).
	if *klioBin == "" {
		exe, err := os.Executable()
		if err != nil {
			fmt.Fprintln(os.Stderr, "cannot resolve klio binary path:", err)
			os.Exit(1)
		}
		// EvalSymlinks gives us the real path; settings.json shouldn't
		// embed `/usr/local/bin/klio` if that's a symlink to a real
		// install location that may move.
		if real, rerr := filepath.EvalSymlinks(exe); rerr == nil {
			*klioBin = real
		} else {
			*klioBin = exe
		}
	}
	if !filepath.IsAbs(*klioBin) {
		fmt.Fprintln(os.Stderr, "--klio-bin must be an absolute path:", *klioBin)
		os.Exit(1)
	}

	if *mcpBin == "" {
		if path, _ := exec.LookPath("klio-mcp"); path != "" {
			*mcpBin = path
		} else {
			*mcpBin = filepath.Join(filepath.Dir(*klioBin), "klio-mcp")
		}
	}
	if !filepath.IsAbs(*mcpBin) {
		fmt.Fprintln(os.Stderr, "--mcp-bin must be an absolute path:", *mcpBin)
		os.Exit(1)
	}

	if _, err := config.EnsureKlioDir(); err != nil {
		fmt.Fprintln(os.Stderr, "ensure ~/.klio:", err)
		os.Exit(1)
	}

	// Phase 1 — bring the local stack online (docker preflight, docker
	// compose up, optional ollama model pull, wait for engine /health).
	// Skipped via --no-stack for users who already manage the stack
	// themselves (e.g. CI environments) or are pointed at a remote
	// engine via --cloud / --engine-url.
	if !*skipStack {
		ui := orchestrator.NewUI()
		ui.Banner("Setting up Klio")

		cwd, _ := os.Getwd()
		steps := []orchestrator.Step{
			orchestrator.StepDockerPreflight(),
			orchestrator.StepComposeUp(
				cwd,
				[]string{"postgres", "redis", "engine"},
				bootstrap.FindKlioProjectRoot,
			),
		}
		if *embedModel != "" {
			steps = append(steps, orchestrator.StepOllamaModel(*embedModel))
		}
		steps = append(steps, orchestrator.StepWaitEngine(*engineURL, *engineTimeout))

		if _, err := orchestrator.Run(context.Background(), ui, steps); err != nil {
			// The orchestrator already printed a red ✗ line; the
			// returned error is what aborted the run. We exit 1 with
			// no extra message to keep the CLI output focused on the
			// remediation hint already shown above.
			os.Exit(1)
		}
		fmt.Fprintln(ui.Out)
	}

	// Build the env block that ends up in BOTH the MCP server entry
	// and every hook command in settings.json. The MCP shim and the
	// hook subcommand both need to find the daemon socket; the
	// keychain hint prevents macOS unsigned-binary prompts.
	env := map[string]string{
		"KLIO_SOCKET_PATH": cfg.SocketPath,
	}
	if os.Getenv("KLIO_USE_FILE_KEYCHAIN") != "" {
		env["KLIO_USE_FILE_KEYCHAIN"] = "1"
	}
	if v := os.Getenv("KLIO_API_URL"); v != "" {
		env["KLIO_API_URL"] = v
	}

	keys := buildKeychain()
	report, err := bootstrap.Run(context.Background(), bootstrap.Options{
		CloudURL:      *cloudURL,
		KlioBinary:    *klioBin,
		KlioMcpBinary: *mcpBin,
		Env:           env,
		Keychain:      keys,
		Email:         *email,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "klio init failed:", err)
		os.Exit(1)
	}
	if report.Reused {
		fmt.Println("✓ Account ready (existing credentials reused)")
	} else {
		fmt.Println("✓ Account provisioned")
	}
	fmt.Printf("    user_id           %s\n", report.UserID)
	fmt.Printf("    agent_id          %s\n", report.AgentID)
	fmt.Printf("    default_space_id  %s\n", report.DefaultSpaceID)

	if len(report.AgentsConfigured) > 0 {
		fmt.Printf("✓ Agents wired: %s\n", strings.Join(report.AgentsConfigured, ", "))
	} else {
		fmt.Println("! No coding agents detected on this machine.")
		fmt.Println("    Install Claude Code, Cursor, or another MCP-capable agent,")
		fmt.Println("    then re-run klio init to wire them up.")
	}
	for _, e := range report.AgentsErrored {
		fmt.Printf("  ! %s\n", e)
	}

	// Write the local-dev env file(s) so the trust-app docker service
	// (and any other consumer of these creds) can auto-login without
	// manual setup. Always writes ~/.klio/local-dev.env, plus a
	// project-root .env when run from inside the klio repo.
	envFileWritten := false
	if !*skipEnvFile {
		cwd, _ := os.Getwd()
		envPaths, err := bootstrap.WriteLocalDevEnv(bootstrap.LocalDevEnvOptions{
			UserID:        report.UserID.String(),
			AgentID:       report.AgentID.String(),
			JWTSigningKey: os.Getenv("KLIO_JWT_SIGNING_KEY"),
			ProjectRoot:   bootstrap.FindKlioProjectRoot(cwd),
		})
		if err != nil {
			fmt.Fprintln(os.Stderr,
				"! could not write local-dev env file:", err)
		} else {
			envFileWritten = true
			for _, p := range envPaths {
				fmt.Printf("    wrote: %s\n", p)
			}
		}
	}

	// Phase 2 — bring up the trust-app dashboard now that the env file
	// is in place. trust-app's compose entry depends on engine being
	// healthy, so it'll wait for the engine container we already
	// brought up. Skipped when --no-stack or env-file write failed
	// (trust-app would 401 without the local-dev creds).
	if !*skipStack && envFileWritten {
		ui := orchestrator.NewUI()
		fmt.Fprintln(ui.Out)
		cwd, _ := os.Getwd()
		trustAppSteps := []orchestrator.Step{
			orchestrator.StepComposeUp(
				cwd,
				[]string{"trust-app"},
				bootstrap.FindKlioProjectRoot,
			),
		}
		if _, err := orchestrator.Run(context.Background(), ui, trustAppSteps); err != nil {
			// Non-fatal: a failed trust-app start doesn't break the
			// engine + agent integrations the user actually came for.
			// We surface a hint and keep going.
			fmt.Fprintln(os.Stderr,
				"  ! trust-app did not start; bring it up later with `docker compose up -d trust-app`")
		}
	}

	fmt.Println()
	fmt.Println("Klio is ready.")
	fmt.Println()
	fmt.Println("  Start the daemon (in another shell):  klio daemon")
	if !*skipStack && envFileWritten {
		fmt.Println("  Open the dashboard:                   http://127.0.0.1:3000")
	}
	fmt.Println("  Inspect status:                       klio status")
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
