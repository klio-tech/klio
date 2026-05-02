package backfill

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/google/uuid"
)

type fakeClient struct {
	mu        sync.Mutex
	ensured   []string
	ingested  int
	failOnce  bool
	failTimes int
}

func (f *fakeClient) EnsureSpace(_ context.Context, slug, _ string) (uuid.UUID, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ensured = append(f.ensured, slug)
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte(slug)), nil
}

func (f *fakeClient) IngestTranscript(
	_ context.Context, _ uuid.UUID, _ string, _ []map[string]any,
) (map[string]any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failOnce && f.failTimes == 0 {
		f.failTimes++
		return nil, errors.New("transient")
	}
	f.ingested++
	return map[string]any{"extracted_count": 1}, nil
}

func writeJSONL(t *testing.T, path string, lines []map[string]any) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, m := range lines {
		body, _ := json.Marshal(m)
		_, _ = f.Write(append(body, '\n'))
	}
}

func TestRunProcessesAllSessions(t *testing.T) {
	dir := t.TempDir()
	proj := filepath.Join(dir, "-Users-test-myproj")
	_ = os.MkdirAll(proj, 0o755)
	for _, sid := range []string{"a", "b", "c"} {
		writeJSONL(t, filepath.Join(proj, sid+".jsonl"), []map[string]any{
			{"role": "user", "content": "I prefer Bun. " + sid},
		})
	}

	client := &fakeClient{}
	cp := NewCheckpoint("")
	report, err := Run(context.Background(), Options{
		Root: dir, Client: client, Checkpoint: cp, MaxConcurrency: 2,
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if report.ProcessedSessions != 3 {
		t.Fatalf("expected 3 processed, got %d", report.ProcessedSessions)
	}
	if client.ingested != 3 {
		t.Fatalf("expected 3 ingested, got %d", client.ingested)
	}
}

func TestRunSkipsCheckpointed(t *testing.T) {
	dir := t.TempDir()
	proj := filepath.Join(dir, "-Users-test-x")
	_ = os.MkdirAll(proj, 0o755)
	writeJSONL(t, filepath.Join(proj, "alpha.jsonl"), []map[string]any{
		{"role": "user", "content": "x"},
	})
	writeJSONL(t, filepath.Join(proj, "beta.jsonl"), []map[string]any{
		{"role": "user", "content": "y"},
	})

	cp := NewCheckpoint("")
	_ = cp.MarkDone("alpha")
	client := &fakeClient{}

	report, _ := Run(context.Background(), Options{
		Root: dir, Client: client, Checkpoint: cp, MaxConcurrency: 1,
	})
	if report.ProcessedSessions != 1 {
		t.Fatalf("expected 1 processed (beta), got %d", report.ProcessedSessions)
	}
	if report.SkippedSessions != 1 {
		t.Fatalf("expected 1 skipped (alpha), got %d", report.SkippedSessions)
	}
}

func TestRunReportsFailures(t *testing.T) {
	dir := t.TempDir()
	proj := filepath.Join(dir, "-Users-test-y")
	_ = os.MkdirAll(proj, 0o755)
	writeJSONL(t, filepath.Join(proj, "f.jsonl"), []map[string]any{
		{"role": "user", "content": "x"},
	})

	client := &fakeClient{failOnce: true}
	cp := NewCheckpoint("")
	_, err := Run(context.Background(), Options{
		Root: dir, Client: client, Checkpoint: cp, MaxConcurrency: 1,
	})
	if err == nil {
		t.Fatal("expected error on failure")
	}
}

func TestCheckpointPersists(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cp.json")

	cp1 := NewCheckpoint(path)
	_ = cp1.MarkDone("session-1")
	_ = cp1.MarkDone("session-2")

	cp2 := NewCheckpoint(path)
	if !cp2.IsDone("session-1") {
		t.Fatal("session-1 not preserved")
	}
	if cp2.IsDone("session-3") {
		t.Fatal("session-3 should not be done")
	}
}
