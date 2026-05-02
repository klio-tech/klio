package bootstrap

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"

	"github.com/klio-tech/bridge/internal/agentadapters"
	"github.com/klio-tech/bridge/internal/keychain"
)

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

	report, err := Run(context.Background(), Options{
		CloudURL:      srv.URL,
		KlioBinary:    "/tmp/klio",
		KlioMcpBinary: "/tmp/klio-mcp",
		Env:           map[string]string{"KLIO_SOCKET_PATH": "/tmp/bridge.sock"},
		Keychain:      kc,
		Adapters:      []agentadapters.Adapter{agentadapters.NewClaudeCodeAdapter()},
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

	// Settings patched
	body, _ := os.ReadFile(filepath.Join(tmp, ".claude", "settings.json"))
	var settings map[string]any
	_ = json.Unmarshal(body, &settings)
	mcp := settings["mcpServers"].(map[string]any)
	if _, ok := mcp["klio"]; !ok {
		t.Fatal("klio mcpServer entry missing")
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

	_, err := Run(context.Background(), Options{
		CloudURL:      srv.URL,
		KlioBinary:    "/tmp/klio",
		KlioMcpBinary: "/tmp/klio-mcp",
		Env:           map[string]string{"KLIO_SOCKET_PATH": "/tmp/bridge.sock"},
		Keychain:      kc,
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if err := Uninstall(context.Background(), kc); err != nil {
		t.Fatalf("Uninstall: %v", err)
	}

	restored, _ := os.ReadFile(filepath.Join(tmp, ".claude", "settings.json"))
	if string(restored) != string(original) {
		t.Fatalf("config not restored:\n  got %q\n  want %q", restored, original)
	}
}
