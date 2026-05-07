package updater

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestPendingWriteAndReadRoundTrips verifies the sentinel survives a
// JSON round-trip. The host watcher reads what the bridge writes;
// these two MUST agree on the schema or auto-update silently never
// fires on the host.
func TestPendingWriteAndReadRoundTrips(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "update-pending.json")

	in := Pending{
		TargetVersion: "0.6.1",
		RequestedAt:   time.Date(2026, 5, 7, 13, 14, 15, 0, time.UTC),
		RequestedBy:   "bridge-auto-update",
		ComposePath:   "/host/.klio/docker-compose.yml",
	}
	if err := WritePending(path, in); err != nil {
		t.Fatalf("WritePending: %v", err)
	}
	out, err := ReadPending(path)
	if err != nil {
		t.Fatalf("ReadPending: %v", err)
	}
	if out == nil {
		t.Fatal("ReadPending returned nil for a written file")
	}
	if out.TargetVersion != in.TargetVersion {
		t.Errorf("TargetVersion: got %q want %q", out.TargetVersion, in.TargetVersion)
	}
	if !out.RequestedAt.Equal(in.RequestedAt) {
		t.Errorf("RequestedAt: got %v want %v", out.RequestedAt, in.RequestedAt)
	}
	if out.RequestedBy != in.RequestedBy {
		t.Errorf("RequestedBy: got %q want %q", out.RequestedBy, in.RequestedBy)
	}
	if out.ComposePath != in.ComposePath {
		t.Errorf("ComposePath: got %q want %q", out.ComposePath, in.ComposePath)
	}
}

// TestReadPendingMissingFileReturnsNilNoError lets the watcher poll
// without spamming errors when no update is pending. Distinguishing
// "no sentinel" (nil, nil) from "broken sentinel" (nil, err) is the
// whole reason ReadPending exists vs a bare os.ReadFile.
func TestReadPendingMissingFileReturnsNilNoError(t *testing.T) {
	out, err := ReadPending("/nonexistent/path/update-pending.json")
	if err != nil {
		t.Fatalf("expected no error for missing file, got: %v", err)
	}
	if out != nil {
		t.Fatalf("expected nil for missing file, got: %+v", out)
	}
}

// TestReadPendingCorruptJSONReturnsError — corrupt sentinel must
// surface, not silently pretend nothing is pending. The watcher
// logs and refuses to apply on parse failure (a hand-edited or
// truncated sentinel could otherwise wedge the host into pulling
// a non-existent tag).
func TestReadPendingCorruptJSONReturnsError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "update-pending.json")
	if err := os.WriteFile(path, []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadPending(path); err == nil {
		t.Fatal("expected error for corrupt JSON, got nil")
	}
}

// TestWritePendingIsAtomic — same atomicity contract as state.go.
// A concurrent reader must never observe a half-written sentinel
// (the watcher polls on a fixed interval; partial reads would lead
// to spurious "corrupt sentinel" errors).
func TestWritePendingIsAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "update-pending.json")
	if err := os.WriteFile(path, []byte("EXISTING_GARBAGE"), 0o644); err != nil {
		t.Fatal(err)
	}
	in := Pending{TargetVersion: "0.6.1", RequestedAt: time.Now().UTC()}
	if err := WritePending(path, in); err != nil {
		t.Fatalf("WritePending: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var parsed Pending
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("post-write file is not valid JSON: %v", err)
	}
	if parsed.TargetVersion != "0.6.1" {
		t.Errorf("post-write content: got %+v", parsed)
	}
}

// TestWritePendingCleansUpTempOnSuccess — atomic-write must leave
// no .tmp files behind. Otherwise repeated writes would slowly
// litter ~/.klio with stale temp files.
func TestWritePendingCleansUpTempOnSuccess(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "update-pending.json")
	in := Pending{TargetVersion: "0.6.1", RequestedAt: time.Now().UTC()}
	if err := WritePending(path, in); err != nil {
		t.Fatalf("WritePending: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "update-pending.json" {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("expected only update-pending.json, got: %v", names)
	}
}

// TestWritePendingPermissionsAre0644 — same world-readable mode as
// the rest of ~/.klio. The host's klio CLI runs as the user, not
// root; restrictive perms would lock the watcher out.
func TestWritePendingPermissionsAre0644(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "update-pending.json")
	in := Pending{TargetVersion: "0.6.1", RequestedAt: time.Now().UTC()}
	if err := WritePending(path, in); err != nil {
		t.Fatalf("WritePending: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o644 {
		t.Errorf("perm: got %o want 0o644", perm)
	}
}

// TestRemovePendingSilentOnMissingFile — the host watcher calls
// Remove after a successful apply; it MUST be idempotent so a
// concurrent second watcher (or a manual `rm`) can't crash the
// daemon by racing the delete.
func TestRemovePendingSilentOnMissingFile(t *testing.T) {
	if err := RemovePending("/nonexistent/update-pending.json"); err != nil {
		t.Errorf("RemovePending on missing file must be a no-op, got: %v", err)
	}
}

// TestRemovePendingDeletesExistingFile — the happy path: apply
// completed, sentinel goes away, next poll observes "nothing
// pending".
func TestRemovePendingDeletesExistingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "update-pending.json")
	in := Pending{TargetVersion: "0.6.1", RequestedAt: time.Now().UTC()}
	if err := WritePending(path, in); err != nil {
		t.Fatal(err)
	}
	if err := RemovePending(path); err != nil {
		t.Fatalf("RemovePending: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("expected file gone after RemovePending; stat err=%v", err)
	}
}
