package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/klio-tech/bridge/internal/config"
	"github.com/klio-tech/bridge/internal/keychain"
)

func makeKeys(t *testing.T) keychain.Backend {
	t.Helper()
	dir := t.TempDir()
	master := sha256.Sum256([]byte("test-master"))
	return keychain.NewFileBackend(filepath.Join(dir, "creds.enc"), master[:])
}

func makeCfg(t *testing.T, cloudURL string) *config.Config {
	t.Helper()
	dir := t.TempDir()
	return &config.Config{
		SocketPath:  filepath.Join(dir, "bridge.sock"),
		CloudURL:    cloudURL,
		LocalOnly:   true, // skip realtime subscriber to keep tests hermetic
		CacheDBPath: filepath.Join(dir, "cache.db"),
	}
}

func TestDaemonRunsAndStops(t *testing.T) {
	cfg := makeCfg(t, "http://localhost:1")
	d, err := New(cfg, makeKeys(t))
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() { errCh <- d.Run(ctx) }()
	time.Sleep(150 * time.Millisecond)

	cancel()
	select {
	case err := <-errCh:
		if err != nil && err != context.Canceled {
			t.Fatalf("Run: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("daemon didn't stop within 2s")
	}
}

func TestRecallProxiesToCloud(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/v1/spaces":
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"id": uuid.NewString(), "name": "Default", "slug": "default", "created_at": "2026-05-02T00:00:00Z"},
			})
		case r.Method == "POST":
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{
					"id":         uuid.NewString(),
					"space_id":   uuid.NewString(),
					"agent_id":   uuid.NewString(),
					"kind":       "memory",
					"content":    "cloud entry",
					"confidence": 1.0,
					"created_at": "2026-05-02T01:00:00Z",
				},
			})
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	cfg := makeCfg(t, srv.URL)
	d, err := New(cfg, makeKeys(t))
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	rows, err := d.Recall(context.Background(), "test", "", "", 10)
	if err != nil {
		t.Fatalf("Recall: %v", err)
	}
	if len(rows) == 0 {
		t.Fatal("expected at least one result")
	}
	if rows[0]["content"] != "cloud entry" {
		t.Fatalf("got %v", rows[0]["content"])
	}
}

func TestWriteQueuesWhenCloudFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/spaces" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"id": uuid.NewString(), "name": "Default", "slug": "default", "created_at": "2026-05-02T00:00:00Z"},
			})
			return
		}
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()

	cfg := makeCfg(t, srv.URL)
	d, err := New(cfg, makeKeys(t))
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	resp, err := d.WriteEntry(context.Background(), "remember", "queued content", "", nil)
	if err != nil {
		t.Fatalf("WriteEntry should succeed offline: %v", err)
	}
	if resp["queued"] != true {
		t.Fatalf("expected queued=true, got %v", resp)
	}

	pending, _ := d.cache.DrainPending(10)
	if len(pending) != 1 {
		t.Fatalf("expected 1 pending, got %d", len(pending))
	}
	if pending[0].Content != "queued content" {
		t.Fatalf("got %s", pending[0].Content)
	}
}
