package agentadapters

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ClaudeCodeAdapter wires Klio into Claude Code by:
//
//   1. Registering the Klio MCP server via the official `claude mcp
//      add-json` CLI (which writes to ~/.claude.json — Claude Code's
//      master config — through Claude's own schema-aware logic).
//   2. Patching ~/.claude/settings.json with the six event hooks
//      (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
//      SubagentStop, Stop).
//
// Why two places: Claude Code reads MCP server configs from
// ~/.claude.json (or via `claude mcp add`), while hooks are read from
// ~/.claude/settings.json. The earlier shipped version of this adapter
// wrote the MCP entry into settings.json — Claude Code silently
// ignored it, so MCP tools never loaded for new sessions, even though
// hooks worked.
//
// All hook commands and the MCP server `command` are written as
// absolute paths because Claude Code spawns these with a minimal PATH
// (typically /usr/bin:/bin), so any reference to `klio` or
// `klio-mcp` as bare names fails to resolve when the binaries live
// elsewhere.
type ClaudeCodeAdapter struct {
	// claudeCLI is the path to the Claude Code CLI used for MCP
	// registration. Empty falls back to LookPath("claude").
	// Tests override via WithClaudeCLI to inject a stub.
	claudeCLI string
}

// AdapterOption is a functional option applied at construction.
type AdapterOption func(*ClaudeCodeAdapter)

// WithClaudeCLI overrides the path to the `claude` binary the
// adapter uses for `claude mcp add-json` / `mcp remove`. Tests use
// this to inject a stub script instead of running the real CLI.
func WithClaudeCLI(path string) AdapterOption {
	return func(a *ClaudeCodeAdapter) { a.claudeCLI = path }
}

func NewClaudeCodeAdapter(opts ...AdapterOption) *ClaudeCodeAdapter {
	a := &ClaudeCodeAdapter{}
	for _, opt := range opts {
		opt(a)
	}
	return a
}

func (a *ClaudeCodeAdapter) Name() string { return "claude-code" }

func (a *ClaudeCodeAdapter) settingsPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "settings.json")
}

func (a *ClaudeCodeAdapter) Installed() bool {
	if _, err := os.Stat(a.settingsPath()); err == nil {
		return true
	}
	// Some installations only have the dir, not settings.json yet.
	home, _ := os.UserHomeDir()
	if _, err := os.Stat(filepath.Join(home, ".claude")); err == nil {
		return true
	}
	return false
}

// Install registers the Klio MCP server via `claude mcp add-json` and
// patches ~/.claude/settings.json with the six event hooks. Idempotent:
// re-running with identical Config replaces the prior MCP entry and
// strips stale hook entries (including legacy bare-command entries
// from older Klio versions).
func (a *ClaudeCodeAdapter) Install(cfg Config) error {
	if cfg.KlioBinary == "" {
		return errors.New("agentadapters: Config.KlioBinary is required")
	}
	if cfg.KlioMcpBinary == "" {
		return errors.New("agentadapters: Config.KlioMcpBinary is required")
	}

	if err := a.registerMCP(cfg); err != nil {
		return fmt.Errorf("register MCP server via claude CLI: %w", err)
	}
	if err := a.patchHooks(cfg); err != nil {
		return fmt.Errorf("patch hooks in settings.json: %w", err)
	}
	return nil
}

// registerMCP shells out to `claude mcp add-json --scope user klio
// <json>` to add the Klio MCP server to ~/.claude.json. We use the CLI
// rather than directly editing ~/.claude.json for two reasons:
//
//  1. ~/.claude.json holds 100KB+ of unrelated state (project
//     bookmarks, telemetry caches, onboarding flags). Touching it via
//     hand-rolled JSON merge risks subtle corruption on schema
//     changes between Claude Code versions.
//  2. The CLI knows the canonical location, scope semantics, and
//     idempotency rules for any future Claude Code version.
//
// If `claude` is not on PATH (rare, since the user obviously has
// Claude Code installed if this adapter ran), Install returns an error
// describing how to install/expose it.
func (a *ClaudeCodeAdapter) registerMCP(cfg Config) error {
	cli := a.claudeCLI
	if cli == "" {
		path, err := exec.LookPath("claude")
		if err != nil {
			return fmt.Errorf(
				"`claude` CLI not found on PATH; install Claude Code or "+
					"pass --claude-cli to klio init: %w", err,
			)
		}
		cli = path
	}

	// Build the JSON payload that `claude mcp add-json` accepts. Shape
	// matches Claude Code's MCP server schema: command + optional args
	// + optional env.
	payload := map[string]any{
		"command": cfg.KlioMcpBinary,
		"args":    []string{},
	}
	if env := envToMap(cfg.Env); env != nil {
		payload["env"] = env
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal MCP payload: %w", err)
	}

	// `claude mcp add-json` is NOT idempotent — it errors with
	// "MCP server klio already exists in user config" if a prior
	// registration is present, regardless of whether the contents
	// match. Remove first (best-effort, ignored if not present) then
	// add. The remove+add pair is atomic from Klio's perspective:
	// either both succeed (fresh registration) or the add fails and
	// we surface the error.
	removeCmd := exec.Command(cli, "mcp", "remove", "--scope", "user", "klio")
	_, _ = removeCmd.CombinedOutput()

	addCmd := exec.Command(
		cli, "mcp", "add-json", "--scope", "user", "klio", string(body),
	)
	out, err := addCmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf(
			"claude mcp add-json failed: %w\n  output: %s",
			err, strings.TrimSpace(string(out)),
		)
	}
	return nil
}

// klioMcpTools is the canonical list of MCP tool names Claude Code
// emits for klio (`mcp__<server>__<tool>`). Used by patchSettings to
// auto-allowlist them in `permissions.allow` so first-time users
// don't get hit with a permission prompt for every klio tool. Keep
// this list in sync with bridge/internal/mcp/dispatcher.go.
var klioMcpTools = []string{
	"mcp__klio__recall",
	"mcp__klio__remember",
	"mcp__klio__observe",
	"mcp__klio__plan",
	"mcp__klio__decide",
	"mcp__klio__note",
	"mcp__klio__space",
}

// patchSettings updates ~/.claude/settings.json with:
//   - the six event hooks pointing at the absolute klio binary;
//   - permissions.allow entries for the 7 klio MCP tools (so users
//     don't see "Do you want to proceed?" prompts on every first
//     tool use);
//   - cleanup of any legacy mcpServers.klio entry written by earlier
//     versions (those entries were inert — Claude Code never read
//     mcpServers from settings.json).
//
// All operations are idempotent: re-running with identical Config
// preserves the file byte-for-byte (the legacy backup mechanism
// produces a fresh `.klio-backup-<ts>` regardless).
func (a *ClaudeCodeAdapter) patchHooks(cfg Config) error {
	path := a.settingsPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(path, []byte("{}"), 0o644); err != nil {
			return err
		}
	}

	settings, err := readJSON(path)
	if err != nil {
		return err
	}
	if err := backupFile(path); err != nil {
		return err
	}

	envMap := envToMap(cfg.Env)

	// Cleanup: drop any legacy mcpServers.klio entry. The MCP server
	// belongs in ~/.claude.json, registered via `claude mcp add-json`.
	if mcp, ok := settings["mcpServers"].(map[string]any); ok {
		delete(mcp, "klio")
		if len(mcp) == 0 {
			delete(settings, "mcpServers")
		} else {
			settings["mcpServers"] = mcp
		}
	}

	hooks, _ := settings["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
	}
	for _, h := range []struct {
		Event   string
		Matcher string
		Subcmd  string
	}{
		{"SessionStart", "*", "session-start"},
		{"UserPromptSubmit", "*", "user-prompt"},
		{"PreToolUse", "Bash|Edit|Write", "pre-tool"},
		{"PostToolUse", "*", "post-tool"},
		{"SubagentStop", "*", "subagent-stop"},
		{"Stop", "*", "session-stop"},
	} {
		setHook(
			hooks,
			h.Event,
			h.Matcher,
			cfg.KlioBinary+" hook "+h.Subcmd,
			envMap,
		)
	}
	settings["hooks"] = hooks

	settings["permissions"] = mergeKlioAllowList(settings["permissions"])

	return writeJSON(path, settings)
}

// mergeKlioAllowList returns a `permissions` block (in Claude Code's
// schema) that contains every klio MCP tool name in `permissions.allow`,
// while preserving any pre-existing `allow`, `deny`, and `ask` lists
// (and any other keys the user added). Tolerant of:
//
//   - missing `permissions` block (returns a fresh one)
//   - existing `permissions.allow` as nil, []string, or []any
//   - non-string entries (preserved as-is)
//   - duplicates already present (no-op)
//
// The output `allow` list keeps the user's prior order, with klio
// entries appended only if absent.
func mergeKlioAllowList(prev any) map[string]any {
	out, _ := prev.(map[string]any)
	if out == nil {
		out = map[string]any{}
	}

	existing, _ := out["allow"].([]any)
	have := make(map[string]bool, len(existing))
	for _, e := range existing {
		if s, ok := e.(string); ok {
			have[s] = true
		}
	}
	for _, name := range klioMcpTools {
		if have[name] {
			continue
		}
		existing = append(existing, name)
		have[name] = true
	}
	out["allow"] = existing
	return out
}

// Uninstall restores ~/.claude/settings.json from the most recent
// backup AND removes the klio MCP server via `claude mcp remove`.
func (a *ClaudeCodeAdapter) Uninstall() error {
	// Best-effort MCP removal first; if `claude` isn't on PATH we still
	// want to attempt the settings.json restore.
	if cli, err := exec.LookPath("claude"); err == nil {
		cmd := exec.Command(cli, "mcp", "remove", "--scope", "user", "klio")
		_, _ = cmd.CombinedOutput() // ignore error: server may already be gone
	}
	return restoreFromBackup(a.settingsPath())
}

// envToMap returns a defensive copy as map[string]any (JSON encoder
// expects any-valued maps). Returns nil when the input is empty so the
// `env` field is omitted from the output entirely.
func envToMap(env map[string]string) map[string]any {
	if len(env) == 0 {
		return nil
	}
	out := make(map[string]any, len(env))
	for k, v := range env {
		out[k] = v
	}
	return out
}

// setHook ensures the hook block at (event, matcher) has exactly one
// klio-owned command for the given subcommand suffix.
//
// Strips ANY prior entry whose command ends with " hook <subcmd>" —
// even if its binary prefix differs from the new one. This keeps
// re-installs idempotent across binary moves (e.g. the user upgraded
// klio from /tmp/klio to /usr/local/bin/klio) and across the legacy
// bare-command format (`klio hook session-start`) we shipped earlier.
func setHook(hooks map[string]any, event, matcher, command string, env map[string]any) {
	idx := strings.LastIndex(command, " hook ")
	hookSuffix := ""
	if idx >= 0 {
		hookSuffix = command[idx:] // " hook <subcmd>"
	}

	newHookEntry := func() map[string]any {
		entry := map[string]any{"type": "command", "command": command}
		if env != nil {
			entry["env"] = env
		}
		return entry
	}

	existingAny := hooks[event]
	existing, _ := existingAny.([]any)
	for _, entry := range existing {
		em, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if em["matcher"] != matcher {
			continue
		}
		emHooks, _ := em["hooks"].([]any)
		filtered := emHooks[:0]
		for _, h := range emHooks {
			hm, _ := h.(map[string]any)
			if hm == nil {
				continue
			}
			cmd, _ := hm["command"].(string)
			if hookSuffix != "" && strings.HasSuffix(cmd, hookSuffix) {
				continue
			}
			filtered = append(filtered, h)
		}
		em["hooks"] = append(filtered, newHookEntry())
		return
	}

	hooks[event] = append(existing, map[string]any{
		"matcher": matcher,
		"hooks":   []any{newHookEntry()},
	})
}
