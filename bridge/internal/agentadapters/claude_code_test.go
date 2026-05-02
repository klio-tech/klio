package agentadapters

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

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
	if err := adapter.Install("/tmp/klio-mcp"); err != nil {
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

	hooks, ok := got["hooks"].(map[string]any)
	if !ok {
		t.Fatal("hooks block missing")
	}
	for _, name := range []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStop", "Stop"} {
		if _, ok := hooks[name]; !ok {
			t.Errorf("hook %s missing", name)
		}
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
	_ = adapter.Install("/tmp/klio-mcp")
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
	_ = adapter.Install("/tmp/klio-mcp")
	_ = adapter.Install("/tmp/klio-mcp") // second call should not duplicate

	updated, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	var got map[string]any
	_ = json.Unmarshal(updated, &got)

	hooks := got["hooks"].(map[string]any)
	for _, name := range []string{"SessionStart", "Stop"} {
		entries := hooks[name].([]any)
		if len(entries) != 1 {
			t.Errorf("hook %s duplicated: %d entries", name, len(entries))
		}
	}
}
