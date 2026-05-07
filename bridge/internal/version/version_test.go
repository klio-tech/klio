package version

import (
	"os"
	"path/filepath"
	"testing"
)

func TestVersionIsSet(t *testing.T) {
	if Get() == "" {
		t.Fatal("version must not be empty")
	}
}

func TestSemverShape(t *testing.T) {
	v := Get()
	if len(v) < 5 {
		t.Fatalf("version %q too short", v)
	}
}

// TestGetFromPathPrefersFile — the production resolution order is
// `/etc/klio-version` (image-baked) → KLIO_BRIDGE_VERSION env →
// `0.0.0-dev`. The file is the sole source of truth in production
// because (a) it can't be accidentally cleared by `unset` in a parent
// shell, and (b) it ships in the same image layer as the binary, so
// the version reported by the bridge is guaranteed to match what's
// running.
//
// This test is the regression test for the v0.6.0 production bug
// where `klio status` reported `current_version=0.0.0-dev` because
// KLIO_BRIDGE_VERSION wasn't set in the running container.
func TestGetFromPathPrefersFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "klio-version")
	if err := os.WriteFile(path, []byte("0.6.1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Even with the env set, the file MUST win.
	t.Setenv("KLIO_BRIDGE_VERSION", "should-be-ignored")
	got := getFromPath(path)
	if got != "0.6.1" {
		t.Errorf("got %q, want %q", got, "0.6.1")
	}
}

// TestGetFromPathTrimsWhitespace — `RUN echo "$KLIO_VERSION" >
// /etc/klio-version` in the Dockerfile leaves a trailing newline.
// Reporting "0.6.1\n" downstream would break the npm CLI's semver
// matcher, the dashboard banner, every JSON consumer.
func TestGetFromPathTrimsWhitespace(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "klio-version")
	// Realistic content from `echo` + a few flavors of operator-edited
	// nonsense (extra blank lines, leading spaces from a copy-paste).
	if err := os.WriteFile(path, []byte("  0.6.1  \n\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := getFromPath(path)
	if got != "0.6.1" {
		t.Errorf("got %q, want %q", got, "0.6.1")
	}
}

// TestGetFromPathFallsBackToEnvOnMissingFile — the dev path: a
// developer running `go run ./cmd/klio version` outside the container
// has no `/etc/klio-version` and probably has KLIO_BRIDGE_VERSION
// set in their shell profile. The env var must be the second
// source of truth.
func TestGetFromPathFallsBackToEnvOnMissingFile(t *testing.T) {
	t.Setenv("KLIO_BRIDGE_VERSION", "0.6.1-dev.local")
	got := getFromPath("/nonexistent/path/klio-version")
	if got != "0.6.1-dev.local" {
		t.Errorf("got %q, want %q", got, "0.6.1-dev.local")
	}
}

// TestGetFromPathFallsBackToDefault — the panic-button case: no file,
// no env. Must return the literal string the design doc specifies
// (the npm CLI's update-state UI keys off this exact value to render
// a "you're on a dev build" banner).
func TestGetFromPathFallsBackToDefault(t *testing.T) {
	// Defensively unset the env in case the developer running tests
	// has it set globally.
	t.Setenv("KLIO_BRIDGE_VERSION", "")
	got := getFromPath("/nonexistent/path/klio-version")
	if got != "0.0.0-dev" {
		t.Errorf("got %q, want %q", got, "0.0.0-dev")
	}
}

// TestGetFromPathEmptyFileFallsBack — an empty file (e.g. `RUN echo
// "" > /etc/klio-version` in a misconfigured Dockerfile, or a
// truncated write) must fall through to env, not be surfaced as the
// empty-string version. An empty version would break JSON consumers
// that expect a non-empty string.
func TestGetFromPathEmptyFileFallsBack(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "klio-version")
	if err := os.WriteFile(path, []byte("\n  \n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KLIO_BRIDGE_VERSION", "0.6.1-from-env")
	got := getFromPath(path)
	if got != "0.6.1-from-env" {
		t.Errorf("got %q, want %q", got, "0.6.1-from-env")
	}
}

// TestGetReadsRealPath — Get() must call getFromPath with the
// production path. We can't write to /etc/klio-version in a test, so
// we assert the looser invariant: Get() returns SOMETHING non-empty
// (at minimum, the default). A future regression that swaps the
// implementation to `return ""` flunks this immediately.
func TestGetReadsRealPath(t *testing.T) {
	if got := Get(); got == "" {
		t.Errorf("Get() returned empty string")
	}
}
