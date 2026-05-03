package agentadapters

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// CursorAdapter wires Klio into Cursor by patching ~/.cursor/mcp.json
// with the Klio MCP server entry. Cursor — unlike Claude Code — does
// not expose a hooks system, so this adapter only manages MCP config;
// session capture for Cursor users still flows through the Klio MCP
// tools (recall/remember/observe/...) which Cursor invokes directly.
//
// Config file shape (Cursor's published format, stable since v0.45):
//
//	{
//	  "mcpServers": {
//	    "klio": {
//	      "command": "/abs/path/to/klio-mcp",
//	      "args": [],
//	      "env": { "KLIO_SOCKET_PATH": "..." }
//	    },
//	    "<other-server>": { ... }
//	  }
//	}
//
// We patch in place so any non-Klio servers the user has registered
// stay intact, and we back up the file before writing for the same
// reason as Claude Code: the user may have hand-edited it.
type CursorAdapter struct{}

func NewCursorAdapter() *CursorAdapter { return &CursorAdapter{} }

func (a *CursorAdapter) Name() string { return "cursor" }

// configPath returns the user-scoped MCP config file location. Cursor
// also supports a project-scoped `.cursor/mcp.json`, but klio init runs
// at the user level: we register globally so Klio works in every
// project the user opens. Project-scoped overrides remain the user's
// to manage.
func (a *CursorAdapter) configPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".cursor", "mcp.json")
}

// Installed reports true when Cursor's user-scoped config directory
// (~/.cursor) exists. We deliberately do NOT require mcp.json itself
// to exist — fresh Cursor installs don't create it until the user
// adds their first MCP server. Detecting the directory is enough to
// say "Cursor is on this machine" and start managing its MCP config.
func (a *CursorAdapter) Installed() bool {
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	if _, err := os.Stat(filepath.Join(home, ".cursor")); err == nil {
		return true
	}
	return false
}

// Install patches ~/.cursor/mcp.json to register the Klio MCP server.
// Idempotent: re-running with identical Config replaces the prior
// "klio" entry without disturbing peer entries or surrounding keys.
func (a *CursorAdapter) Install(cfg Config) error {
	if cfg.KlioMcpBinary == "" {
		return errors.New("agentadapters: Config.KlioMcpBinary is required")
	}

	path := a.configPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create %s: %w", filepath.Dir(path), err)
	}

	// Seed an empty file if absent so readJSON returns an empty map
	// rather than os.ErrNotExist. We back up afterwards (the backup
	// of an empty `{}` is harmless and keeps the restore-from-backup
	// path uniform with Claude Code).
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(path, []byte("{}"), 0o644); err != nil {
			return fmt.Errorf("seed %s: %w", path, err)
		}
	}

	settings, err := readJSON(path)
	if err != nil {
		return err
	}
	if err := backupFile(path); err != nil {
		return fmt.Errorf("backup %s: %w", path, err)
	}

	servers, _ := settings["mcpServers"].(map[string]any)
	if servers == nil {
		servers = map[string]any{}
	}

	entry := map[string]any{
		"command": cfg.KlioMcpBinary,
		"args":    []any{},
	}
	if env := envToMap(cfg.Env); env != nil {
		entry["env"] = env
	}
	servers["klio"] = entry
	settings["mcpServers"] = servers

	return writeJSON(path, settings)
}

// Uninstall restores ~/.cursor/mcp.json from the most recent backup.
// If no backup exists (e.g. user manually deleted it), we fall back
// to removing the "klio" key from the current file rather than
// failing — partial cleanup is better than no cleanup.
func (a *CursorAdapter) Uninstall() error {
	path := a.configPath()
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err := restoreFromBackup(path); err == nil {
		return nil
	}
	// Backup missing — strip the klio entry in place.
	settings, err := readJSON(path)
	if err != nil {
		return err
	}
	if servers, ok := settings["mcpServers"].(map[string]any); ok {
		delete(servers, "klio")
		if len(servers) == 0 {
			delete(settings, "mcpServers")
		} else {
			settings["mcpServers"] = servers
		}
	}
	return writeJSON(path, settings)
}
