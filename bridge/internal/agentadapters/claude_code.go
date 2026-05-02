package agentadapters

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// ClaudeCodeAdapter detects Claude Code via ~/.claude/settings.json and
// patches both the mcpServers map and the hooks block.
//
// Critical detail: Claude Code spawns hook commands via the OS process
// API with a minimal PATH (typically /usr/bin:/bin), so any reference
// to `klio` as a bare command name fails to resolve when the binary
// lives in /tmp, /opt/klio/bin, or anywhere else not on the system PATH.
// Both the MCP `command` and every hook `command` are therefore written
// as absolute paths sourced from the `Config` passed by the caller.
type ClaudeCodeAdapter struct{}

func NewClaudeCodeAdapter() *ClaudeCodeAdapter { return &ClaudeCodeAdapter{} }

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

// Install patches Claude Code settings to add Klio's MCP server and the
// six event hooks. Idempotent: re-running with identical Config makes
// no further changes; running with a different binary path or env
// updates the relevant entries in place.
func (a *ClaudeCodeAdapter) Install(cfg Config) error {
	if cfg.KlioBinary == "" {
		return errors.New("agentadapters: Config.KlioBinary is required")
	}
	if cfg.KlioMcpBinary == "" {
		return errors.New("agentadapters: Config.KlioMcpBinary is required")
	}

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

	// mcpServers — the MCP shim spawned by Claude Code at session start.
	mcp, _ := settings["mcpServers"].(map[string]any)
	if mcp == nil {
		mcp = map[string]any{}
	}
	klioServer := map[string]any{
		"command": cfg.KlioMcpBinary,
		"args":    []string{},
	}
	if envMap != nil {
		klioServer["env"] = envMap
	}
	mcp["klio"] = klioServer
	settings["mcpServers"] = mcp

	// hooks — six events, each calling `<KlioBinary> hook <event>`.
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

	return writeJSON(path, settings)
}

func (a *ClaudeCodeAdapter) Uninstall() error {
	return restoreFromBackup(a.settingsPath())
}

// envToMap returns a defensive copy as map[string]any (the JSON encoder
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
// Strips ANY prior entry whose command ends with " hook <subcmd>" — even
// if its binary prefix differs from the new one. This keeps re-installs
// idempotent across binary moves (e.g. the user upgraded klio from
// /tmp/klio to /usr/local/bin/klio) and across the legacy bare-command
// format (`klio hook session-start`) we shipped before this fix. The
// caller passes the full new command so we can derive the suffix.
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
			// Strip any prior klio-owned entry for this hook subcommand.
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
