package agentadapters

import (
	"errors"
	"os"
	"path/filepath"
)

// ClaudeCodeAdapter detects Claude Code via ~/.claude/settings.json and
// patches both the mcpServers map and the hooks block.
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

// Install patches Claude Code settings to add Klio's MCP server and hooks.
// All hooks point at `klio-bridge hook <event>` which the Phase J impl backs.
func (a *ClaudeCodeAdapter) Install(klioMcpBinary string) error {
	path := a.settingsPath()

	// Ensure ~/.claude exists, and settings.json exists at minimum as `{}`.
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

	// mcpServers
	mcp, _ := settings["mcpServers"].(map[string]any)
	if mcp == nil {
		mcp = map[string]any{}
	}
	mcp["klio"] = map[string]any{
		"command": klioMcpBinary,
		"args":    []string{},
	}
	settings["mcpServers"] = mcp

	// hooks (Phase J wires the daemon-side handlers)
	hooks, _ := settings["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
	}
	addHook(hooks, "SessionStart", "*", "klio hook session-start")
	addHook(hooks, "UserPromptSubmit", "*", "klio hook user-prompt")
	addHook(hooks, "PreToolUse", "Bash|Edit|Write", "klio hook pre-tool")
	addHook(hooks, "PostToolUse", "*", "klio hook post-tool")
	addHook(hooks, "SubagentStop", "*", "klio hook subagent-stop")
	addHook(hooks, "Stop", "*", "klio hook session-stop")
	settings["hooks"] = hooks

	return writeJSON(path, settings)
}

func (a *ClaudeCodeAdapter) Uninstall() error {
	return restoreFromBackup(a.settingsPath())
}

func addHook(hooks map[string]any, event, matcher, command string) {
	existingAny := hooks[event]
	existing, _ := existingAny.([]any)
	for _, entry := range existing {
		em, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if em["matcher"] == matcher {
			emHooks, _ := em["hooks"].([]any)
			for _, h := range emHooks {
				hm, _ := h.(map[string]any)
				if hm != nil && hm["command"] == command {
					return // already present
				}
			}
			em["hooks"] = append(emHooks, map[string]any{
				"type":    "command",
				"command": command,
			})
			return
		}
	}
	hooks[event] = append(existing, map[string]any{
		"matcher": matcher,
		"hooks":   []any{map[string]any{"type": "command", "command": command}},
	})
}
