package bootstrap

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"

	"github.com/klio-tech/bridge/internal/agentadapters"
	"github.com/klio-tech/bridge/internal/keychain"
)

// fakeClaude writes a stub `claude` shell script that no-ops and exits
// 0. Used by tests so we don't invoke the real Claude Code CLI (which
// would mutate ~/.claude.json on the developer's machine).
func fakeClaude(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	binPath := filepath.Join(tmp, "claude")
	script := `#!/usr/bin/env bash
exit 0
`
	if err := os.WriteFile(binPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake claude: %v", err)
	}
	return binPath
}

func TestRunProvisionsAndPatches(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	_ = os.MkdirAll(filepath.Join(tmp, ".claude"), 0o755)
	_ = os.WriteFile(filepath.Join(tmp, ".claude", "settings.json"), []byte("{}"), 0o644)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"user_id":          uuid.New().String(),
			"agent_id":         uuid.New().String(),
			"api_key":          "rt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
			"claimed":          false,
			"default_space_id": uuid.New().String(),
		})
	}))
	defer srv.Close()

	master := sha256.Sum256([]byte("test-master"))
	kc := keychain.NewFileBackend(filepath.Join(tmp, "creds.enc"), master[:])

	adapter := agentadapters.NewClaudeCodeAdapter(
		agentadapters.WithClaudeCLI(fakeClaude(t)),
	)

	report, err := Run(context.Background(), Options{
		CloudURL:      srv.URL,
		KlioBinary:    "/tmp/klio",
		KlioMcpBinary: "/tmp/klio-mcp",
		Env:           map[string]string{"KLIO_SOCKET_PATH": "/tmp/bridge.sock"},
		Keychain:      kc,
		Adapters:      []agentadapters.Adapter{adapter},
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if report.UserID == uuid.Nil {
		t.Fatal("UserID empty")
	}
	if len(report.AgentsConfigured) != 1 || report.AgentsConfigured[0] != "claude-code" {
		t.Fatalf("expected claude-code configured, got %v", report.AgentsConfigured)
	}

	// Credentials persisted
	rt, err := kc.Get("refresh_token")
	if err != nil {
		t.Fatalf("refresh_token missing: %v", err)
	}
	if string(rt) != "rt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" {
		t.Fatalf("refresh_token wrong: %s", rt)
	}

	// Settings patched — hooks present, mcpServers.klio NOT (it lives
	// in ~/.claude.json now, registered by the fake claude CLI).
	body, _ := os.ReadFile(filepath.Join(tmp, ".claude", "settings.json"))
	var settings map[string]any
	_ = json.Unmarshal(body, &settings)
	hooks, ok := settings["hooks"].(map[string]any)
	if !ok {
		t.Fatal("hooks block missing in settings.json")
	}
	for _, ev := range []string{"SessionStart", "PreToolUse", "PostToolUse"} {
		if _, ok := hooks[ev]; !ok {
			t.Errorf("hook %s missing", ev)
		}
	}
	if mcp, ok := settings["mcpServers"].(map[string]any); ok {
		if _, has := mcp["klio"]; has {
			t.Error("mcpServers.klio should not be in settings.json after migration")
		}
	}
}

func TestRunIsIdempotentOnExistingCreds(t *testing.T) {
	// Second Run with the same keychain must not re-provision a new
	// account; should re-use the saved (user_id, agent_id, default_space_id)
	// and just re-patch agent configs.
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	_ = os.MkdirAll(filepath.Join(tmp, ".claude"), 0o755)
	_ = os.WriteFile(filepath.Join(tmp, ".claude", "settings.json"), []byte("{}"), 0o644)

	provisionCalls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		provisionCalls++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"user_id":          uuid.New().String(),
			"agent_id":         uuid.New().String(),
			"api_key":          fmt.Sprintf("rt_call_%d", provisionCalls),
			"claimed":          false,
			"default_space_id": uuid.New().String(),
		})
	}))
	defer srv.Close()

	master := sha256.Sum256([]byte("test-master"))
	kc := keychain.NewFileBackend(filepath.Join(tmp, "creds.enc"), master[:])

	adapter := agentadapters.NewClaudeCodeAdapter(
		agentadapters.WithClaudeCLI(fakeClaude(t)),
	)
	mkOpts := func() Options {
		return Options{
			CloudURL:      srv.URL,
			KlioBinary:    "/tmp/klio",
			KlioMcpBinary: "/tmp/klio-mcp",
			Env:           map[string]string{"KLIO_SOCKET_PATH": "/tmp/bridge.sock"},
			Keychain:      kc,
			Adapters:      []agentadapters.Adapter{adapter},
		}
	}

	first, err := Run(context.Background(), mkOpts())
	if err != nil {
		t.Fatalf("first Run: %v", err)
	}
	if first.Reused {
		t.Fatal("first Run should NOT be a reuse")
	}

	second, err := Run(context.Background(), mkOpts())
	if err != nil {
		t.Fatalf("second Run: %v", err)
	}
	if !second.Reused {
		t.Fatal("second Run should reuse existing creds")
	}
	if second.UserID != first.UserID {
		t.Errorf("UserID changed across runs: %s -> %s", first.UserID, second.UserID)
	}
	if provisionCalls != 1 {
		t.Errorf("provision endpoint hit %d times; expected exactly 1", provisionCalls)
	}
}

func TestUninstallReverses(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	_ = os.MkdirAll(filepath.Join(tmp, ".claude"), 0o755)
	original := []byte(`{"theme":"dark"}`)
	_ = os.WriteFile(filepath.Join(tmp, ".claude", "settings.json"), original, 0o644)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"user_id":          uuid.New().String(),
			"agent_id":         uuid.New().String(),
			"api_key":          "rt_test",
			"claimed":          false,
			"default_space_id": uuid.New().String(),
		})
	}))
	defer srv.Close()

	master := sha256.Sum256([]byte("test-master"))
	kc := keychain.NewFileBackend(filepath.Join(tmp, "creds.enc"), master[:])

	adapter := agentadapters.NewClaudeCodeAdapter(
		agentadapters.WithClaudeCLI(fakeClaude(t)),
	)

	_, err := Run(context.Background(), Options{
		CloudURL:      srv.URL,
		KlioBinary:    "/tmp/klio",
		KlioMcpBinary: "/tmp/klio-mcp",
		Env:           map[string]string{"KLIO_SOCKET_PATH": "/tmp/bridge.sock"},
		Keychain:      kc,
		Adapters:      []agentadapters.Adapter{adapter},
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	// Uninstall in this test uses agentadapters.All() — its real
	// adapter has no claudeCLI override, so the `claude mcp remove`
	// call may fail quietly (no `claude` on PATH in test env). The
	// key assertion is that settings.json is restored from backup
	// regardless.
	t.Setenv("PATH", "") // force claude lookup to fail
	if err := Uninstall(context.Background(), kc); err != nil {
		t.Fatalf("Uninstall: %v", err)
	}

	restored, _ := os.ReadFile(filepath.Join(tmp, ".claude", "settings.json"))
	if string(restored) != string(original) {
		t.Fatalf("config not restored:\n  got %q\n  want %q", restored, original)
	}
}
