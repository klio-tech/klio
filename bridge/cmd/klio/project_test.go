// Tests for the `klio project ...` subcommand family.
//
// runProjectPromote is the unit under test. We exercise it end-to-end
// through a stub HTTP server that mimics the engine's /v1/tokens/refresh
// (auth bootstrap), /v1/projects/ensure (remote-to-uuid resolution),
// and /v1/projects/{id}/promote (the actual mutation). All persistent
// state (config dir, keychain) is redirected to t.TempDir() via $HOME
// + KLIO_USE_FILE_KEYCHAIN so the tests are hermetic.
//
// We assert on:
//  1. The promote endpoint is reached and receives the correct body.
//  2. UUID positional args bypass /v1/projects/ensure entirely.
//  3. Flag XOR is enforced before any HTTP call (`--space` AND
//     `--embedding` together → exit 2 / usage error).
//  4. The same XOR error when neither is passed.
//
// We deliberately don't reach into the cloud package for this — the
// goal here is exercising the CLI dispatch + arg parsing + the engine
// contract from the outside, NOT the cloud package's unit-test surface
// (which has its own coverage in internal/cloud/client_test.go).
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// seedTestEnv redirects HOME to a per-test temp dir, switches the
// keychain to the file backend (no macOS Keychain prompt during go
// test), points the cloud client at the supplied test server, and
// seeds a refresh token into the keychain so c.Refresh() succeeds.
//
// Returns nothing — all setup is via t.Setenv (auto-restored at
// test end) plus a direct file write to the keychain's location.
func seedTestEnv(t *testing.T, serverURL string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KLIO_USE_FILE_KEYCHAIN", "1")
	t.Setenv("KLIO_API_URL", serverURL)

	// The file keychain backend writes to ~/.klio/credentials.enc;
	// `os.MkdirAll` it first so Set() doesn't error on the missing
	// parent directory. Production code path goes through
	// config.EnsureKlioDir for the same reason.
	if err := os.MkdirAll(filepath.Join(home, ".klio"), 0o700); err != nil {
		t.Fatalf("mkdir ~/.klio: %v", err)
	}
	// Write refresh_token via the same code path production uses,
	// so we exercise the real keychain backend.
	keys := buildKeychain()
	if err := keys.Set("refresh_token", []byte("seed-refresh")); err != nil {
		t.Fatalf("seed refresh_token: %v", err)
	}
	if _, err := keys.Get("refresh_token"); err != nil {
		t.Fatalf("seeded refresh_token not readable: %v", err)
	}
}

// refreshHandler is the canned /v1/tokens/refresh response — every
// authenticated CLI command calls this before its real mutation, so
// every test that does network needs the stub to answer it.
func refreshHandler(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"access_token":  "test-access",
		"refresh_token": "test-refresh",
		"expires_in":    3600,
	})
}

// TestProjectPromoteCallsEngineWithRemote verifies the happy path:
// a git-remote positional arg is resolved through /v1/projects/ensure,
// then /v1/projects/{id}/promote is called with the --space body.
func TestProjectPromoteCallsEngineWithRemote(t *testing.T) {
	var (
		ensureCalls, promoteCalls atomic.Int32
		gotPromoteBody            map[string]any
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v1/tokens/refresh":
			refreshHandler(w)
		case r.URL.Path == "/v1/projects/ensure":
			ensureCalls.Add(1)
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["git_remote"] != "git@github.com:klio-tech/klio.git" {
				t.Errorf("ensure git_remote = %v", body["git_remote"])
			}
			if body["display_name"] != "klio-tech/klio" {
				t.Errorf("ensure display_name = %v", body["display_name"])
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(
				`{"id":"00000000-0000-0000-0000-000000000001"}`))
		case strings.HasPrefix(r.URL.Path, "/v1/projects/") &&
			strings.HasSuffix(r.URL.Path, "/promote"):
			promoteCalls.Add(1)
			if r.URL.Path != "/v1/projects/00000000-0000-0000-0000-000000000001/promote" {
				t.Errorf("wrong promote path: %s", r.URL.Path)
			}
			_ = json.NewDecoder(r.Body).Decode(&gotPromoteBody)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(
				`{"project_id":"00000000-0000-0000-0000-000000000001",` +
					`"dedicated_space_id":"00000000-0000-0000-0000-000000000002"}`))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	seedTestEnv(t, srv.URL)

	err := runProjectPromote([]string{
		"git@github.com:klio-tech/klio.git",
		"--space", "00000000-0000-0000-0000-000000000002",
	})
	if err != nil {
		t.Fatalf("runProjectPromote: %v", err)
	}
	if n := ensureCalls.Load(); n != 1 {
		t.Errorf("ensure call count = %d, want 1", n)
	}
	if n := promoteCalls.Load(); n != 1 {
		t.Errorf("promote call count = %d, want 1", n)
	}
	if gotPromoteBody["space_id"] != "00000000-0000-0000-0000-000000000002" {
		t.Errorf("promote space_id = %v", gotPromoteBody["space_id"])
	}
	if _, present := gotPromoteBody["embedding_model"]; present {
		t.Errorf("embedding_model should be omitted, got body: %v", gotPromoteBody)
	}
}

// TestProjectPromoteWithUUIDSkipsEnsure verifies that when the
// positional arg parses as a UUID, /v1/projects/ensure is NOT called —
// we go straight to the promote endpoint with the supplied id.
func TestProjectPromoteWithUUIDSkipsEnsure(t *testing.T) {
	var ensureCalls, promoteCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v1/tokens/refresh":
			refreshHandler(w)
		case r.URL.Path == "/v1/projects/ensure":
			ensureCalls.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"00000000-0000-0000-0000-000000000099"}`))
		case strings.HasPrefix(r.URL.Path, "/v1/projects/") &&
			strings.HasSuffix(r.URL.Path, "/promote"):
			promoteCalls.Add(1)
			if r.URL.Path != "/v1/projects/00000000-0000-0000-0000-000000000001/promote" {
				t.Errorf("promote path = %s (should be exactly the UUID we passed)", r.URL.Path)
			}
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["embedding_model"] != "ollama/snowflake-arctic-embed2" {
				t.Errorf("embedding_model = %v", body["embedding_model"])
			}
			if _, present := body["space_id"]; present {
				t.Errorf("space_id should be omitted, got: %v", body)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(
				`{"project_id":"00000000-0000-0000-0000-000000000001",` +
					`"dedicated_space_id":"00000000-0000-0000-0000-000000000003"}`))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	seedTestEnv(t, srv.URL)

	err := runProjectPromote([]string{
		"00000000-0000-0000-0000-000000000001",
		"--embedding", "ollama/snowflake-arctic-embed2",
	})
	if err != nil {
		t.Fatalf("runProjectPromote: %v", err)
	}
	if n := ensureCalls.Load(); n != 0 {
		t.Errorf("ensure should NOT be called for a UUID positional, got %d calls", n)
	}
	if n := promoteCalls.Load(); n != 1 {
		t.Errorf("promote call count = %d, want 1", n)
	}
}

// TestProjectPromoteRejectsBothFlags verifies the XOR check fires
// BEFORE any HTTP call — passing both --space and --embedding is a
// usage error (exit 2 in the dispatcher path).
func TestProjectPromoteRejectsBothFlags(t *testing.T) {
	// No server — if a request fires, net/http will fail loudly.
	t.Setenv("HOME", t.TempDir())
	t.Setenv("KLIO_USE_FILE_KEYCHAIN", "1")

	err := runProjectPromote([]string{
		"git@github.com:klio-tech/klio.git",
		"--space", "00000000-0000-0000-0000-000000000002",
		"--embedding", "stub",
	})
	if err == nil {
		t.Fatal("expected error when both --space and --embedding are passed")
	}
	if !strings.Contains(err.Error(), "exactly one") {
		t.Errorf("expected 'exactly one' in error, got: %v", err)
	}
	if !isUsageError(err) {
		t.Errorf("expected usageError, got: %T %v", err, err)
	}
}

// TestProjectPromoteRejectsNeitherFlag verifies the symmetric case:
// no flag at all is also a usage error.
func TestProjectPromoteRejectsNeitherFlag(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("KLIO_USE_FILE_KEYCHAIN", "1")

	err := runProjectPromote([]string{"git@github.com:klio-tech/klio.git"})
	if err == nil {
		t.Fatal("expected error when neither --space nor --embedding is passed")
	}
	if !strings.Contains(err.Error(), "exactly one") {
		t.Errorf("expected 'exactly one' in error, got: %v", err)
	}
	if !isUsageError(err) {
		t.Errorf("expected usageError, got: %T %v", err, err)
	}
}

// TestProjectPromoteRejectsInvalidSpaceUUID verifies that --space
// values are validated as UUIDs client-side, BEFORE any network call.
// Catches typos / shell-quoting mishaps without burning an engine
// round-trip and a confusing 4xx.
func TestProjectPromoteRejectsInvalidSpaceUUID(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("KLIO_USE_FILE_KEYCHAIN", "1")

	err := runProjectPromote([]string{
		"git@github.com:klio-tech/klio.git",
		"--space", "not-a-uuid",
	})
	if err == nil {
		t.Fatal("expected error for non-UUID --space")
	}
	if !isUsageError(err) {
		t.Errorf("expected usageError, got: %T %v", err, err)
	}
}

// TestProjectPromoteFlagsBeforePositional verifies that placing
// --space BEFORE the positional arg (the order our usage line
// suggests is the alternative) also works. Catches regressions in
// the reorderFlagsFirst helper — without it, Go's `flag` package
// would stop parsing at the positional and miss the --embedding /
// --space flag depending on order.
func TestProjectPromoteFlagsBeforePositional(t *testing.T) {
	var promoteCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v1/tokens/refresh":
			refreshHandler(w)
		case strings.HasSuffix(r.URL.Path, "/promote"):
			promoteCalls.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(
				`{"project_id":"00000000-0000-0000-0000-000000000001",` +
					`"dedicated_space_id":"00000000-0000-0000-0000-000000000002"}`))
		}
	}))
	defer srv.Close()
	seedTestEnv(t, srv.URL)

	err := runProjectPromote([]string{
		"--space", "00000000-0000-0000-0000-000000000002",
		"00000000-0000-0000-0000-000000000001",
	})
	if err != nil {
		t.Fatalf("runProjectPromote: %v", err)
	}
	if n := promoteCalls.Load(); n != 1 {
		t.Errorf("promote call count = %d, want 1", n)
	}
}

// TestReorderFlagsFirst is a focused unit test on the reorder helper
// so future regressions in flag-anywhere ergonomics aren't masked by
// the end-to-end CLI tests' setup noise.
func TestReorderFlagsFirst(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want []string
	}{
		{"empty", nil, []string{}},
		{
			"positional first then flag-eq",
			[]string{"git@host:org/repo.git", "--space=abc"},
			[]string{"--space=abc", "git@host:org/repo.git"},
		},
		{
			"positional first then two-token flag",
			[]string{"git@host:org/repo.git", "--space", "abc"},
			[]string{"--space", "abc", "git@host:org/repo.git"},
		},
		{
			"already in canonical order is a noop",
			[]string{"--space", "abc", "git@host:org/repo.git"},
			[]string{"--space", "abc", "git@host:org/repo.git"},
		},
		{
			"dash-dash terminator preserves following positionals",
			[]string{"--", "--space", "abc"},
			[]string{"--", "--space", "abc"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := reorderFlagsFirst(tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("reorderFlagsFirst(%v) = %v, want %v", tc.in, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("[%d] = %q, want %q", i, got[i], tc.want[i])
				}
			}
		})
	}
}

// TestProjectPromoteRejectsMissingPositional verifies that omitting
// the <remote-or-uuid> positional is a usage error.
func TestProjectPromoteRejectsMissingPositional(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("KLIO_USE_FILE_KEYCHAIN", "1")

	err := runProjectPromote([]string{
		"--space", "00000000-0000-0000-0000-000000000002",
	})
	if err == nil {
		t.Fatal("expected error when positional arg is missing")
	}
	if !isUsageError(err) {
		t.Errorf("expected usageError, got: %T %v", err, err)
	}
}
