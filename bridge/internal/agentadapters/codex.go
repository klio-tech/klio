package agentadapters

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	toml "github.com/pelletier/go-toml/v2"
)

// CodexAdapter wires Klio into OpenAI Codex by patching
// ~/.codex/config.toml with the Klio MCP server entry. Codex — like
// Cursor and unlike Claude Code — does not expose a hooks system, so
// this adapter only manages MCP config; session capture for Codex
// users still flows through the Klio MCP tools (recall/remember/...)
// which Codex invokes directly.
//
// Config file shape (Codex's published TOML format):
//
//	[mcp_servers.klio]
//	command = "/abs/path/to/klio-mcp"
//	args = []
//
//	[mcp_servers.klio.env]
//	KLIO_SOCKET_PATH = "..."
//
//	[mcp_servers.<other-server>]
//	command = "..."
//
// We patch in place so any non-Klio servers and unrelated top-level
// keys (e.g. `telemetry = false`) the user has set stay intact, and we
// back up the file before writing for the same reason as Cursor: the
// user may have hand-edited it.
type CodexAdapter struct{}

func NewCodexAdapter() *CodexAdapter { return &CodexAdapter{} }

func (a *CodexAdapter) Name() string { return "codex" }

// configPath returns the user-scoped Codex config file location. Codex
// reads MCP servers from this single location; klio init runs at the
// user level and registers globally so Klio works in every project the
// user opens.
func (a *CodexAdapter) configPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex", "config.toml")
}

// Installed reports true when Codex's user-scoped config directory
// (~/.codex) exists. We deliberately do NOT require config.toml itself
// to exist — fresh Codex installs may not create it until first use.
// Detecting the directory is enough to say "Codex is on this machine"
// and start managing its MCP config.
func (a *CodexAdapter) Installed() bool {
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	if _, err := os.Stat(filepath.Join(home, ".codex")); err == nil {
		return true
	}
	return false
}

// Install patches ~/.codex/config.toml to register the Klio MCP server.
// Idempotent: re-running with identical Config replaces the prior
// `[mcp_servers.klio]` section without disturbing peer entries or
// unrelated top-level keys.
func (a *CodexAdapter) Install(cfg Config) error {
	if cfg.KlioMcpBinary == "" {
		return errors.New("agentadapters: Config.KlioMcpBinary is required")
	}

	path := a.configPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create %s: %w", filepath.Dir(path), err)
	}

	// If the file does not exist, treat it as an empty document. Unlike
	// Cursor's mcp.json (where we seed `{}` so the read path is
	// uniform), TOML's empty-document representation is just an empty
	// file, which readTOML already handles. We only seed the file when
	// it's missing so that backupFile (which requires the file to
	// exist) has something to copy.
	existed := true
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		existed = false
		if err := os.WriteFile(path, []byte(""), 0o644); err != nil {
			return fmt.Errorf("seed %s: %w", path, err)
		}
	}

	settings, err := readTOML(path)
	if err != nil {
		return err
	}
	if existed {
		if err := backupFile(path); err != nil {
			return fmt.Errorf("backup %s: %w", path, err)
		}
	}

	servers, _ := settings["mcp_servers"].(map[string]any)
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
	settings["mcp_servers"] = servers

	return writeTOML(path, settings)
}

// Uninstall restores ~/.codex/config.toml from the most recent backup.
// If no backup exists (e.g. user manually deleted it, or the original
// install pre-dated the backup convention), we fall back to removing
// the `[mcp_servers.klio]` section from the current file rather than
// failing — partial cleanup is better than no cleanup.
func (a *CodexAdapter) Uninstall() error {
	path := a.configPath()
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err := restoreFromBackup(path); err == nil {
		return nil
	}
	// Backup missing — strip the klio entry in place.
	settings, err := readTOML(path)
	if err != nil {
		return err
	}
	if servers, ok := settings["mcp_servers"].(map[string]any); ok {
		delete(servers, "klio")
		if len(servers) == 0 {
			delete(settings, "mcp_servers")
		} else {
			settings["mcp_servers"] = servers
		}
	}
	return writeTOML(path, settings)
}

// readTOML loads a TOML file as a map[string]any. Empty/missing files
// return an empty map. Malformed TOML returns an error.
//
// Kept private to this file (rather than promoted to util.go) because
// Codex is currently the only TOML-backed adapter; if a second TOML
// adapter lands later, this is a one-line move.
func readTOML(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return map[string]any{}, nil
	}
	var out map[string]any
	if err := toml.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("config at %s is not valid TOML: %w", path, err)
	}
	return out, nil
}

// writeTOML marshals data back to the path. go-toml/v2 emits stable
// output (sorted keys at each level) which makes the idempotency
// property — re-installing with the same Config produces a
// byte-identical file — hold even after a round-trip through the
// in-memory map.
func writeTOML(path string, data map[string]any) error {
	body, err := toml.Marshal(data)
	if err != nil {
		return err
	}
	return os.WriteFile(path, body, 0o644)
}
