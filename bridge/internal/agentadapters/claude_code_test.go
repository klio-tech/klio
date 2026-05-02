package agentadapters

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func defaultCfg() Config {
	return Config{
		KlioBinary:    "/tmp/klio",
		KlioMcpBinary: "/tmp/klio-mcp",
		Env: map[string]string{
			"KLIO_SOCKET_PATH":       "/home/u/.klio/bridge.sock",
			"KLIO_USE_FILE_KEYCHAIN": "1",
		},
	}
}

func TestClaudeCodeDetectsViaSettings(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	dir := filepath.Join(tmp, ".claude")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "settings.json"), []byte("{}"), 0o644)

	if !NewClaudeCodeAdapter().Installed() {
		t.Fatal("expected Claude Code to be detected")
	}
}

func TestClaudeCodeInstallPatchesMcpAndHooks(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	dir := filepath.Join(tmp, ".claude")
	_ = os.MkdirAll(dir, 0o755)
	original := map[string]any{
		"theme": "dark",
		"mcpServers": map[string]any{
			"existing": map[string]any{"command": "x"},
		},
	}
	body, _ := json.Marshal(original)
	_ = os.WriteFile(filepath.Join(dir, "settings.json"), body, 0o644)

	adapter := NewClaudeCodeAdapter()
	if err := adapter.Install(defaultCfg()); err != nil {
		t.Fatalf("Install: %v", err)
	}

	updated, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	var got map[string]any
	_ = json.Unmarshal(updated, &got)

	if got["theme"] != "dark" {
		t.Fatal("preserved theme key was lost")
	}

	mcp := got["mcpServers"].(map[string]any)
	if _, ok := mcp["existing"]; !ok {
		t.Fatal("preserved existing mcpServer entry was removed")
	}
	klio, ok := mcp["klio"].(map[string]any)
	if !ok {
		t.Fatal("klio entry not added")
	}
	if klio["command"] != "/tmp/klio-mcp" {
		t.Fatalf("command: %v", klio["command"])
	}
	klioEnv, ok := klio["env"].(map[string]any)
	if !ok {
		t.Fatal("klio MCP entry missing env block")
	}
	if klioEnv["KLIO_SOCKET_PATH"] != "/home/u/.klio/bridge.sock" {
		t.Fatalf("env.KLIO_SOCKET_PATH: %v", klioEnv["KLIO_SOCKET_PATH"])
	}

	hooks, ok := got["hooks"].(map[string]any)
	if !ok {
		t.Fatal("hooks block missing")
	}
	for _, name := range []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStop", "Stop"} {
		entries, ok := hooks[name].([]any)
		if !ok || len(entries) == 0 {
			t.Errorf("hook %s missing", name)
			continue
		}
		first := entries[0].(map[string]any)
		hookList := first["hooks"].([]any)
		hookEntry := hookList[0].(map[string]any)
		cmd, _ := hookEntry["command"].(string)
		if !strings.HasPrefix(cmd, "/tmp/klio hook ") {
			t.Errorf("hook %s command not absolute: %q", name, cmd)
		}
		if _, ok := hookEntry["env"].(map[string]any); !ok {
			t.Errorf("hook %s missing env block", name)
		}
	}
}

func TestClaudeCodeInstallRejectsBareBinary(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	dir := filepath.Join(tmp, ".claude")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "settings.json"), []byte("{}"), 0o644)

	a := NewClaudeCodeAdapter()
	if err := a.Install(Config{}); err == nil {
		t.Fatal("expected error when KlioBinary is empty")
	}
	if err := a.Install(Config{KlioBinary: "/tmp/klio"}); err == nil {
		t.Fatal("expected error when KlioMcpBinary is empty")
	}
}

func TestClaudeCodeUninstallRestoresBackup(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	dir := filepath.Join(tmp, ".claude")
	_ = os.MkdirAll(dir, 0o755)
	original := []byte(`{"theme":"dark"}`)
	_ = os.WriteFile(filepath.Join(dir, "settings.json"), original, 0o644)

	adapter := NewClaudeCodeAdapter()
	_ = adapter.Install(defaultCfg())
	if err := adapter.Uninstall(); err != nil {
		t.Fatalf("Uninstall: %v", err)
	}

	restored, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	if string(restored) != string(original) {
		t.Fatalf("restored content mismatch:\n  got %q\n  want %q", restored, original)
	}
}

func TestClaudeCodeInstallIsIdempotent(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	dir := filepath.Join(tmp, ".claude")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "settings.json"), []byte("{}"), 0o644)

	adapter := NewClaudeCodeAdapter()
	_ = adapter.Install(defaultCfg())
	_ = adapter.Install(defaultCfg()) // second call should not duplicate

	updated, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	var got map[string]any
	_ = json.Unmarshal(updated, &got)

	hooks := got["hooks"].(map[string]any)
	for _, name := range []string{"SessionStart", "Stop"} {
		entries := hooks[name].([]any)
		if len(entries) != 1 {
			t.Errorf("hook %s duplicated at outer level: %d entries", name, len(entries))
		}
		first := entries[0].(map[string]any)
		hookList := first["hooks"].([]any)
		if len(hookList) != 1 {
			t.Errorf("hook %s duplicated commands: %d entries", name, len(hookList))
		}
	}
}

func TestClaudeCodeReinstallUpdatesEnv(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	dir := filepath.Join(tmp, ".claude")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "settings.json"), []byte("{}"), 0o644)

	adapter := NewClaudeCodeAdapter()
	old := defaultCfg()
	old.Env["KLIO_SOCKET_PATH"] = "/old/path/bridge.sock"
	_ = adapter.Install(old)

	updated := defaultCfg()
	updated.Env["KLIO_SOCKET_PATH"] = "/new/path/bridge.sock"
	_ = adapter.Install(updated)

	body, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	var s map[string]any
	_ = json.Unmarshal(body, &s)

	hooks := s["hooks"].(map[string]any)
	first := hooks["SessionStart"].([]any)[0].(map[string]any)
	hookList := first["hooks"].([]any)
	hookEntry := hookList[0].(map[string]any)
	env := hookEntry["env"].(map[string]any)
	if env["KLIO_SOCKET_PATH"] != "/new/path/bridge.sock" {
		t.Fatalf("re-install did not update env: %v", env)
	}
}
