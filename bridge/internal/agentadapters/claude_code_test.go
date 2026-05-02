package agentadapters

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeClaude writes a stub `claude` shell script that records its
// invocations to logFile and exits 0. Returns the absolute path of the
// stub. Used by all Install tests to avoid invoking the real Claude
// Code CLI.
func fakeClaude(t *testing.T, logFile string) string {
	t.Helper()
	tmp := t.TempDir()
	binPath := filepath.Join(tmp, "claude")
	script := fmt.Sprintf(`#!/usr/bin/env bash
{
  echo "ARGS:"
  for a in "$@"; do echo "  $a"; done
} >> %q
exit 0
`, logFile)
	if err := os.WriteFile(binPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake claude: %v", err)
	}
	return binPath
}

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

func TestClaudeCodeInstallRegistersMcpAndPatchesHooks(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	dir := filepath.Join(tmp, ".claude")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"theme":"dark"}`), 0o644)

	logFile := filepath.Join(tmp, "claude-invocations.log")
	adapter := &ClaudeCodeAdapter{claudeCLI: fakeClaude(t, logFile)}

	if err := adapter.Install(defaultCfg()); err != nil {
		t.Fatalf("Install: %v", err)
	}

	// The fake claude must have been called twice: first to remove
	// any prior klio entry (idempotency), then to add the fresh one.
	// `claude mcp add-json` errors when the entry already exists, so
	// the remove must come first on EVERY install.
	logBody, _ := os.ReadFile(logFile)
	log := string(logBody)
	removeIdx := strings.Index(log, "remove")
	addIdx := strings.Index(log, "add-json")
	if removeIdx == -1 {
		t.Errorf("expected `claude mcp remove` call; got log:\n%s", log)
	}
	if addIdx == -1 {
		t.Errorf("expected `claude mcp add-json` call; got log:\n%s", log)
	}
	if removeIdx >= 0 && addIdx >= 0 && removeIdx >= addIdx {
		t.Errorf("`mcp remove` must precede `mcp add-json`; got log:\n%s", log)
	}
	for _, want := range []string{"mcp", "add-json", "--scope", "user", "klio"} {
		if !strings.Contains(log, want) {
			t.Errorf("expected claude CLI to be called with %q; got log:\n%s", want, log)
		}
	}
	if !strings.Contains(log, "/tmp/klio-mcp") {
		t.Errorf("expected MCP payload to mention klio-mcp binary; got:\n%s", log)
	}

	// Hooks must be patched into settings.json with absolute paths.
	updated, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	var got map[string]any
	_ = json.Unmarshal(updated, &got)
	if got["theme"] != "dark" {
		t.Fatal("preserved theme key was lost")
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

	// settings.json must NOT contain a stale mcpServers.klio entry —
	// the MCP server lives in ~/.claude.json now (registered via the CLI).
	if mcp, ok := got["mcpServers"].(map[string]any); ok {
		if _, has := mcp["klio"]; has {
			t.Error("mcpServers.klio should not be in settings.json after migration")
		}
	}
}

func TestClaudeCodeInstallAddsPermissionsAllowList(t *testing.T) {
	// All 7 klio MCP tool names must be added to permissions.allow so
	// users don't see "Do you want to proceed?" prompts on first use.
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	dir := filepath.Join(tmp, ".claude")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "settings.json"), []byte("{}"), 0o644)

	logFile := filepath.Join(tmp, "claude.log")
	adapter := &ClaudeCodeAdapter{claudeCLI: fakeClaude(t, logFile)}
	if err := adapter.Install(defaultCfg()); err != nil {
		t.Fatalf("Install: %v", err)
	}

	body, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	var s map[string]any
	_ = json.Unmarshal(body, &s)

	perms, ok := s["permissions"].(map[string]any)
	if !ok {
		t.Fatal("permissions block missing")
	}
	allow, ok := perms["allow"].([]any)
	if !ok {
		t.Fatal("permissions.allow missing or wrong type")
	}
	want := []string{
		"mcp__klio__recall", "mcp__klio__remember", "mcp__klio__observe",
		"mcp__klio__plan", "mcp__klio__decide", "mcp__klio__note",
		"mcp__klio__space",
	}
	have := map[string]bool{}
	for _, e := range allow {
		if s, ok := e.(string); ok {
			have[s] = true
		}
	}
	for _, w := range want {
		if !have[w] {
			t.Errorf("permissions.allow missing %q; got: %v", w, allow)
		}
	}
}

func TestClaudeCodeInstallPreservesExistingPermissions(t *testing.T) {
	// Pre-existing permissions.allow / .deny / .ask must be preserved;
	// klio entries appended without disturbing user's prior config.
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	dir := filepath.Join(tmp, ".claude")
	_ = os.MkdirAll(dir, 0o755)
	original := map[string]any{
		"permissions": map[string]any{
			"allow": []any{"Bash(npm:*)", "Bash(git:*)"},
			"deny":  []any{"Bash(rm -rf:*)"},
			"ask":   []any{"WebFetch(*)"},
		},
	}
	body, _ := json.Marshal(original)
	_ = os.WriteFile(filepath.Join(dir, "settings.json"), body, 0o644)

	logFile := filepath.Join(tmp, "claude.log")
	adapter := &ClaudeCodeAdapter{claudeCLI: fakeClaude(t, logFile)}
	if err := adapter.Install(defaultCfg()); err != nil {
		t.Fatalf("Install: %v", err)
	}

	updated, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	var got map[string]any
	_ = json.Unmarshal(updated, &got)
	perms := got["permissions"].(map[string]any)

	allow := perms["allow"].([]any)
	allowSet := map[string]bool{}
	for _, e := range allow {
		allowSet[e.(string)] = true
	}
	if !allowSet["Bash(npm:*)"] || !allowSet["Bash(git:*)"] {
		t.Error("user's pre-existing allow entries were lost")
	}
	if !allowSet["mcp__klio__recall"] {
		t.Error("klio entries not appended")
	}

	deny := perms["deny"].([]any)
	if len(deny) != 1 || deny[0] != "Bash(rm -rf:*)" {
		t.Error("pre-existing deny list was disturbed")
	}
	ask := perms["ask"].([]any)
	if len(ask) != 1 || ask[0] != "WebFetch(*)" {
		t.Error("pre-existing ask list was disturbed")
	}
}

func TestClaudeCodeInstallPermissionsIdempotent(t *testing.T) {
	// Re-installing must NOT duplicate klio entries in permissions.allow.
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	dir := filepath.Join(tmp, ".claude")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "settings.json"), []byte("{}"), 0o644)

	logFile := filepath.Join(tmp, "claude.log")
	adapter := &ClaudeCodeAdapter{claudeCLI: fakeClaude(t, logFile)}
	_ = adapter.Install(defaultCfg())
	_ = adapter.Install(defaultCfg())
	_ = adapter.Install(defaultCfg())

	body, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	var s map[string]any
	_ = json.Unmarshal(body, &s)
	allow := s["permissions"].(map[string]any)["allow"].([]any)

	count := map[string]int{}
	for _, e := range allow {
		if name, ok := e.(string); ok {
			count[name]++
		}
	}
	for _, name := range []string{
		"mcp__klio__recall", "mcp__klio__remember", "mcp__klio__observe",
	} {
		if count[name] != 1 {
			t.Errorf("%s appears %d times after 3 installs; want 1", name, count[name])
		}
	}
}

func TestClaudeCodeInstallStripsLegacyMcpServersEntry(t *testing.T) {
	// Earlier Klio versions wrote an inert mcpServers.klio block into
	// settings.json. Re-install must clean it up so we don't leave
	// stale config around.
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	dir := filepath.Join(tmp, ".claude")
	_ = os.MkdirAll(dir, 0o755)
	original := map[string]any{
		"mcpServers": map[string]any{
			"klio":  map[string]any{"command": "/old/path/klio-mcp"},
			"other": map[string]any{"command": "/something/else"},
		},
		"hooks": map[string]any{},
	}
	body, _ := json.Marshal(original)
	_ = os.WriteFile(filepath.Join(dir, "settings.json"), body, 0o644)

	logFile := filepath.Join(tmp, "claude.log")
	adapter := &ClaudeCodeAdapter{claudeCLI: fakeClaude(t, logFile)}
	if err := adapter.Install(defaultCfg()); err != nil {
		t.Fatalf("Install: %v", err)
	}

	updated, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	var got map[string]any
	_ = json.Unmarshal(updated, &got)

	mcp, _ := got["mcpServers"].(map[string]any)
	if _, has := mcp["klio"]; has {
		t.Error("legacy mcpServers.klio should have been removed")
	}
	if _, has := mcp["other"]; !has {
		t.Error("unrelated mcpServers entries must be preserved")
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

	logFile := filepath.Join(tmp, "claude.log")
	adapter := &ClaudeCodeAdapter{claudeCLI: fakeClaude(t, logFile)}
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

	logFile := filepath.Join(tmp, "claude.log")
	adapter := &ClaudeCodeAdapter{claudeCLI: fakeClaude(t, logFile)}
	if err := adapter.Install(defaultCfg()); err != nil {
		t.Fatalf("first Install: %v", err)
	}
	if err := adapter.Install(defaultCfg()); err != nil {
		t.Fatalf("second Install: %v", err)
	}

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

	logFile := filepath.Join(tmp, "claude.log")
	adapter := &ClaudeCodeAdapter{claudeCLI: fakeClaude(t, logFile)}

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
		t.Fatalf("re-install did not update hook env: %v", env)
	}

	// Also verify the MCP registration was called twice with the new env.
	logBody, _ := os.ReadFile(logFile)
	if !strings.Contains(string(logBody), "/new/path/bridge.sock") {
		t.Errorf("re-install did not pass new env to claude CLI; log:\n%s", logBody)
	}
}

func TestClaudeCodeInstallFailsWhenClaudeCLIMissing(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("PATH", tmp) // no `claude` here
	dir := filepath.Join(tmp, ".claude")
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "settings.json"), []byte("{}"), 0o644)

	adapter := NewClaudeCodeAdapter()
	err := adapter.Install(defaultCfg())
	if err == nil {
		t.Fatal("expected Install to fail when claude CLI is missing")
	}
	if !strings.Contains(err.Error(), "claude") {
		t.Errorf("error should mention `claude` CLI; got: %v", err)
	}
}
