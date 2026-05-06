package updater

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestReadMissingFileReturnsZeroState(t *testing.T) {
	s, err := Read("/nonexistent/path/update-state.json")
	if err != nil {
		t.Fatalf("expected no error for missing file, got: %v", err)
	}
	if s.CurrentVersion != "" {
		t.Errorf("expected zero state, got CurrentVersion=%q", s.CurrentVersion)
	}
}

func TestRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "update-state.json")
	in := State{
		CurrentVersion:            "0.6.0",
		LastCheckAt:               time.Date(2026, 5, 7, 13, 14, 15, 0, time.UTC),
		LastKnownAvailableVersion: "0.6.1",
		LastAppliedVersion:        "0.6.0",
		LastAppliedAt:             time.Date(2026, 5, 7, 7, 0, 0, 0, time.UTC),
	}
	if err := Write(path, in); err != nil {
		t.Fatalf("Write: %v", err)
	}
	out, err := Read(path)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if out.CurrentVersion != in.CurrentVersion {
		t.Errorf("CurrentVersion: got %q want %q", out.CurrentVersion, in.CurrentVersion)
	}
	if !out.LastCheckAt.Equal(in.LastCheckAt) {
		t.Errorf("LastCheckAt: got %v want %v", out.LastCheckAt, in.LastCheckAt)
	}
	if out.LastKnownAvailableVersion != in.LastKnownAvailableVersion {
		t.Errorf("LastKnownAvailableVersion: got %q want %q", out.LastKnownAvailableVersion, in.LastKnownAvailableVersion)
	}
	if out.LastAppliedVersion != in.LastAppliedVersion {
		t.Errorf("LastAppliedVersion: got %q want %q", out.LastAppliedVersion, in.LastAppliedVersion)
	}
	if !out.LastAppliedAt.Equal(in.LastAppliedAt) {
		t.Errorf("LastAppliedAt: got %v want %v", out.LastAppliedAt, in.LastAppliedAt)
	}
}

func TestReadCorruptJSONReturnsError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "update-state.json")
	if err := os.WriteFile(path, []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := Read(path)
	if err == nil {
		t.Fatal("expected error for corrupt JSON, got nil")
	}
}

func TestWriteIsAtomic(t *testing.T) {
	// Atomic-write contract: even if the file already exists with
	// arbitrary content, a successful Write produces a file whose
	// bytes are the new state in full — never a partial overwrite.
	dir := t.TempDir()
	path := filepath.Join(dir, "update-state.json")
	if err := os.WriteFile(path, []byte("EXISTING_GARBAGE"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := State{CurrentVersion: "0.6.0"}
	if err := Write(path, s); err != nil {
		t.Fatalf("Write: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var parsed State
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("post-write file is not valid JSON: %v\ncontent: %q", err, raw)
	}
	if parsed.CurrentVersion != "0.6.0" {
		t.Errorf("post-write content: got %+v", parsed)
	}
}

func TestWriteCleansUpTempOnSuccess(t *testing.T) {
	// Atomic-write should leave NO temp files after a successful run.
	dir := t.TempDir()
	path := filepath.Join(dir, "update-state.json")
	s := State{CurrentVersion: "0.6.0"}
	if err := Write(path, s); err != nil {
		t.Fatalf("Write: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "update-state.json" {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("expected only update-state.json, got: %v", names)
	}
}

func TestWritePermissionsAre0644(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "update-state.json")
	s := State{CurrentVersion: "0.6.0"}
	if err := Write(path, s); err != nil {
		t.Fatalf("Write: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o644 {
		t.Errorf("perm: got %o want 0o644", perm)
	}
}
