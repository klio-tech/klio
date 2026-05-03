package agentadapters

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	toml "github.com/pelletier/go-toml/v2"
)

// Codex's adapter resolves ~/.codex/config.toml relative to HOME, so
// each test runs inside withFakeHome(t) — the same sandbox helper Cursor
// uses (defined in cursor_test.go) — to avoid touching the developer's
// real Codex install.

func TestCodexAdapter_NotInstalled_WhenNoCodexDir(t *testing.T) {
	withFakeHome(t)
	a := NewCodexAdapter()
	if a.Installed() {
		t.Fatalf("Installed should be false when ~/.codex does not exist")
	}
}

func TestCodexAdapter_Installed_WhenCodexDirExists(t *testing.T) {
	home := withFakeHome(t)
	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o755); err != nil {
		t.Fatal(err)
	}
	a := NewCodexAdapter()
	if !a.Installed() {
		t.Fatalf("Installed should be true when ~/.codex exists")
	}
}

func TestCodexAdapter_Install_CreatesConfigWithKlioServer(t *testing.T) {
	home := withFakeHome(t)
	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o755); err != nil {
		t.Fatal(err)
	}
	a := NewCodexAdapter()
	cfg := Config{
		KlioBinary:    "/usr/local/bin/klio",
		KlioMcpBinary: "/usr/local/bin/klio-mcp",
		Env:           map[string]string{"KLIO_SOCKET_PATH": "/tmp/klio.sock"},
	}
	if err := a.Install(cfg); err != nil {
		t.Fatalf("Install failed: %v", err)
	}

	body, err := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := toml.Unmarshal(body, &got); err != nil {
		t.Fatalf("config not valid TOML: %v\n%s", err, body)
	}
	servers, _ := got["mcp_servers"].(map[string]any)
	if servers == nil {
		t.Fatalf("mcp_servers missing: %s", body)
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

func TestCodexAdapter_Install_PreservesPeerServers(t *testing.T) {
	home := withFakeHome(t)
	codexDir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(codexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	prior := []byte(`telemetry = false

[mcp_servers.filesystem]
command = "/opt/fs"
args = ["--root", "/"]
`)
	if err := os.WriteFile(filepath.Join(codexDir, "config.toml"), prior, 0o644); err != nil {
		t.Fatal(err)
	}

	a := NewCodexAdapter()
	if err := a.Install(Config{KlioMcpBinary: "/abs/klio-mcp", Env: map[string]string{"K": "V"}}); err != nil {
		t.Fatal(err)
	}

	body, _ := os.ReadFile(filepath.Join(codexDir, "config.toml"))
	var got map[string]any
	if err := toml.Unmarshal(body, &got); err != nil {
		t.Fatalf("config not valid TOML after install: %v\n%s", err, body)
	}
	servers, _ := got["mcp_servers"].(map[string]any)
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

func TestCodexAdapter_Install_Idempotent(t *testing.T) {
	home := withFakeHome(t)
	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o755); err != nil {
		t.Fatal(err)
	}
	a := NewCodexAdapter()
	cfg := Config{KlioMcpBinary: "/abs/klio-mcp", Env: map[string]string{"K": "V"}}
	if err := a.Install(cfg); err != nil {
		t.Fatal(err)
	}
	first, _ := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if err := a.Install(cfg); err != nil {
		t.Fatal(err)
	}
	second, _ := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if string(first) != string(second) {
		t.Errorf("re-install changed config:\nfirst:  %s\nsecond: %s", first, second)
	}
}

func TestCodexAdapter_Install_RejectsMissingMcpBinary(t *testing.T) {
	withFakeHome(t)
	a := NewCodexAdapter()
	if err := a.Install(Config{}); err == nil {
		t.Fatalf("expected error when KlioMcpBinary is empty")
	}
}

func TestCodexAdapter_Uninstall_RestoresFromBackup(t *testing.T) {
	home := withFakeHome(t)
	codexDir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(codexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	original := []byte(`[mcp_servers.fs]
command = "/opt/fs"
`)
	if err := os.WriteFile(filepath.Join(codexDir, "config.toml"), original, 0o644); err != nil {
		t.Fatal(err)
	}

	a := NewCodexAdapter()
	if err := a.Install(Config{KlioMcpBinary: "/abs/klio-mcp"}); err != nil {
		t.Fatal(err)
	}
	if err := a.Uninstall(); err != nil {
		t.Fatal(err)
	}

	body, _ := os.ReadFile(filepath.Join(codexDir, "config.toml"))
	if !strings.Contains(string(body), "fs") {
		t.Errorf("fs entry missing after restore: %s", body)
	}
	if strings.Contains(string(body), "klio") {
		t.Errorf("klio entry still present after restore: %s", body)
	}
}

func TestCodexAdapter_Uninstall_StripsKlioWhenBackupMissing(t *testing.T) {
	home := withFakeHome(t)
	codexDir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(codexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	current := []byte(`[mcp_servers.klio]
command = "/abs/klio-mcp"

[mcp_servers.fs]
command = "/opt/fs"
`)
	if err := os.WriteFile(filepath.Join(codexDir, "config.toml"), current, 0o644); err != nil {
		t.Fatal(err)
	}

	a := NewCodexAdapter()
	if err := a.Uninstall(); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(filepath.Join(codexDir, "config.toml"))
	var got map[string]any
	if err := toml.Unmarshal(body, &got); err != nil {
		t.Fatalf("post-uninstall config not valid TOML: %v\n%s", err, body)
	}
	servers, _ := got["mcp_servers"].(map[string]any)
	if _, ok := servers["klio"]; ok {
		t.Errorf("klio not stripped: %s", body)
	}
	if _, ok := servers["fs"]; !ok {
		t.Errorf("peer 'fs' entry lost: %s", body)
	}
}

func TestCodexAdapter_Uninstall_NoConfigIsNoOp(t *testing.T) {
	withFakeHome(t)
	a := NewCodexAdapter()
	if err := a.Uninstall(); err != nil {
		t.Fatalf("Uninstall on empty home should be no-op, got %v", err)
	}
}
