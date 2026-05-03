package agentadapters

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withFakeHome relocates HOME to a tempdir for the duration of t and
// restores it afterwards. Cursor's adapter resolves ~/.cursor/mcp.json
// relative to HOME, so this gives each test its own filesystem sandbox.
func withFakeHome(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	old := os.Getenv("HOME")
	t.Setenv("HOME", dir)
	t.Cleanup(func() { _ = os.Setenv("HOME", old) })
	return dir
}

func TestCursorAdapter_NotInstalled_WhenNoCursorDir(t *testing.T) {
	withFakeHome(t)
	a := NewCursorAdapter()
	if a.Installed() {
		t.Fatalf("Installed should be false when ~/.cursor does not exist")
	}
}

func TestCursorAdapter_Installed_WhenCursorDirExists(t *testing.T) {
	home := withFakeHome(t)
	if err := os.MkdirAll(filepath.Join(home, ".cursor"), 0o755); err != nil {
		t.Fatal(err)
	}
	a := NewCursorAdapter()
	if !a.Installed() {
		t.Fatalf("Installed should be true when ~/.cursor exists")
	}
}

func TestCursorAdapter_Install_CreatesConfigWithKlioServer(t *testing.T) {
	home := withFakeHome(t)
	if err := os.MkdirAll(filepath.Join(home, ".cursor"), 0o755); err != nil {
		t.Fatal(err)
	}
	a := NewCursorAdapter()
	cfg := Config{
		KlioBinary:    "/usr/local/bin/klio",
		KlioMcpBinary: "/usr/local/bin/klio-mcp",
		Env:           map[string]string{"KLIO_SOCKET_PATH": "/tmp/klio.sock"},
	}
	if err := a.Install(cfg); err != nil {
		t.Fatalf("Install failed: %v", err)
	}

	body, err := os.ReadFile(filepath.Join(home, ".cursor", "mcp.json"))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("config not valid JSON: %v\n%s", err, body)
	}
	servers, _ := got["mcpServers"].(map[string]any)
	if servers == nil {
		t.Fatalf("mcpServers missing: %s", body)
	}
	klio, ok := servers["klio"].(map[string]any)
	if !ok {
		t.Fatalf("klio entry missing: %s", body)
	}
	if cmd, _ := klio["command"].(string); cmd != "/usr/local/bin/klio-mcp" {
		t.Errorf("command = %q want /usr/local/bin/klio-mcp", cmd)
	}
	env, _ := klio["env"].(map[string]any)
	if env == nil || env["KLIO_SOCKET_PATH"] != "/tmp/klio.sock" {
		t.Errorf("env mismatch: %v", env)
	}
}

func TestCursorAdapter_Install_PreservesPeerServers(t *testing.T) {
	home := withFakeHome(t)
	cursorDir := filepath.Join(home, ".cursor")
	if err := os.MkdirAll(cursorDir, 0o755); err != nil {
		t.Fatal(err)
	}
	prior := []byte(`{
  "mcpServers": {
    "filesystem": { "command": "/opt/fs", "args": ["--root","/"] }
  },
  "telemetry": false
}`)
	if err := os.WriteFile(filepath.Join(cursorDir, "mcp.json"), prior, 0o644); err != nil {
		t.Fatal(err)
	}

	a := NewCursorAdapter()
	if err := a.Install(Config{KlioMcpBinary: "/abs/klio-mcp", Env: map[string]string{"K": "V"}}); err != nil {
		t.Fatal(err)
	}

	body, _ := os.ReadFile(filepath.Join(cursorDir, "mcp.json"))
	var got map[string]any
	_ = json.Unmarshal(body, &got)
	servers, _ := got["mcpServers"].(map[string]any)
	if _, ok := servers["filesystem"]; !ok {
		t.Errorf("peer 'filesystem' server lost: %s", body)
	}
	if _, ok := servers["klio"]; !ok {
		t.Errorf("klio server not added: %s", body)
	}
	if got["telemetry"] != false {
		t.Errorf("non-mcp top-level keys lost: %s", body)
	}
}

func TestCursorAdapter_Install_Idempotent(t *testing.T) {
	home := withFakeHome(t)
	if err := os.MkdirAll(filepath.Join(home, ".cursor"), 0o755); err != nil {
		t.Fatal(err)
	}
	a := NewCursorAdapter()
	cfg := Config{KlioMcpBinary: "/abs/klio-mcp", Env: map[string]string{"K": "V"}}
	if err := a.Install(cfg); err != nil {
		t.Fatal(err)
	}
	first, _ := os.ReadFile(filepath.Join(home, ".cursor", "mcp.json"))
	if err := a.Install(cfg); err != nil {
		t.Fatal(err)
	}
	second, _ := os.ReadFile(filepath.Join(home, ".cursor", "mcp.json"))
	if string(first) != string(second) {
		t.Errorf("re-install changed config:\nfirst:  %s\nsecond: %s", first, second)
	}
}

func TestCursorAdapter_Install_RejectsMissingMcpBinary(t *testing.T) {
	withFakeHome(t)
	a := NewCursorAdapter()
	if err := a.Install(Config{}); err == nil {
		t.Fatalf("expected error when KlioMcpBinary is empty")
	}
}

func TestCursorAdapter_Uninstall_RestoresFromBackup(t *testing.T) {
	home := withFakeHome(t)
	cursorDir := filepath.Join(home, ".cursor")
	if err := os.MkdirAll(cursorDir, 0o755); err != nil {
		t.Fatal(err)
	}
	original := []byte(`{
  "mcpServers": { "fs": { "command": "/opt/fs" } }
}`)
	if err := os.WriteFile(filepath.Join(cursorDir, "mcp.json"), original, 0o644); err != nil {
		t.Fatal(err)
	}

	a := NewCursorAdapter()
	if err := a.Install(Config{KlioMcpBinary: "/abs/klio-mcp"}); err != nil {
		t.Fatal(err)
	}
	if err := a.Uninstall(); err != nil {
		t.Fatal(err)
	}

	body, _ := os.ReadFile(filepath.Join(cursorDir, "mcp.json"))
	if !strings.Contains(string(body), `"fs"`) {
		t.Errorf("fs entry missing after restore: %s", body)
	}
	if strings.Contains(string(body), `"klio"`) {
		t.Errorf("klio entry still present after restore: %s", body)
	}
}

func TestCursorAdapter_Uninstall_StripsKlioWhenBackupMissing(t *testing.T) {
	home := withFakeHome(t)
	cursorDir := filepath.Join(home, ".cursor")
	if err := os.MkdirAll(cursorDir, 0o755); err != nil {
		t.Fatal(err)
	}
	current := []byte(`{
  "mcpServers": {
    "klio": { "command": "/abs/klio-mcp" },
    "fs":   { "command": "/opt/fs" }
  }
}`)
	if err := os.WriteFile(filepath.Join(cursorDir, "mcp.json"), current, 0o644); err != nil {
		t.Fatal(err)
	}

	a := NewCursorAdapter()
	if err := a.Uninstall(); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(filepath.Join(cursorDir, "mcp.json"))
	if strings.Contains(string(body), `"klio"`) {
		t.Errorf("klio not stripped: %s", body)
	}
	if !strings.Contains(string(body), `"fs"`) {
		t.Errorf("peer 'fs' entry lost: %s", body)
	}
}

func TestCursorAdapter_Uninstall_NoConfigIsNoOp(t *testing.T) {
	withFakeHome(t)
	a := NewCursorAdapter()
	if err := a.Uninstall(); err != nil {
		t.Fatalf("Uninstall on empty home should be no-op, got %v", err)
	}
}
