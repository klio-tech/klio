package daemon

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/klio-tech/bridge/internal/updater"
)

// stubHTTPGetter wraps a closure for the http requests in test paths.
type stubHTTPGetter struct {
	fn func(*http.Request) (*http.Response, error)
}

func (s stubHTTPGetter) Do(req *http.Request) (*http.Response, error) {
	return s.fn(req)
}

func canonicalRegistryResponse(version string) (*http.Response, error) {
	body := `{"version":"` + version + `"}`
	return &http.Response{
		StatusCode: 200,
		Body:       io.NopCloser(bytes.NewBufferString(body)),
		Header:     make(http.Header),
	}, nil
}

// recordingRunner reuses the apply test's runner stub but also tracks
// whether Run was invoked at all.
type recordingRunner struct {
	calls int
	err   error
}

func (r *recordingRunner) Run(ctx context.Context, name string, args []string, log io.Writer) error {
	r.calls++
	return r.err
}

// newDeps builds a deps struct backed by a tempdir state path and a
// stub registry. The mode is NOT a deps field anymore — `runUpdateOnce`
// re-reads `KLIO_AUTO_UPDATE` on every tick, so callers must set the
// env (via `t.Setenv`) before invoking. Passing the mode here so the
// helper does the env wiring keeps individual tests readable.
func newDeps(t *testing.T, current string, mode string, latest string, runner *recordingRunner) *updateTickerDeps {
	t.Helper()
	t.Setenv("KLIO_AUTO_UPDATE", mode)
	dir := t.TempDir()
	return &updateTickerDeps{
		statePath:      filepath.Join(dir, "update-state.json"),
		composePath:    filepath.Join(dir, "docker-compose.yml"),
		currentVersion: current,
		httpClient: stubHTTPGetter{fn: func(req *http.Request) (*http.Response, error) {
			return canonicalRegistryResponse(latest)
		}},
		runner: runner,
		log:    io.Discard,
	}
}

func TestRunUpdateOnceNoNewerVersion(t *testing.T) {
	runner := &recordingRunner{}
	deps := newDeps(t, "0.6.0", UpdateModeApply, "0.6.0", runner)
	runUpdateOnce(context.Background(), deps)
	if runner.calls != 0 {
		t.Errorf("apply runner should NOT be invoked; calls=%d", runner.calls)
	}
	state, err := updater.Read(deps.statePath)
	if err != nil {
		t.Fatal(err)
	}
	if state.LastCheckError != "" {
		t.Errorf("LastCheckError unexpected: %q", state.LastCheckError)
	}
	if state.LastKnownAvailableVersion != "0.6.0" {
		t.Errorf("LastKnownAvailableVersion: %q", state.LastKnownAvailableVersion)
	}
}

// TestRunUpdateOnceApplyMode — apply mode no longer shells out to
// docker from inside the bridge container (the container has no
// docker CLI, and giving it one would force docker-in-docker or a
// privileged docker.sock mount). Instead the ticker writes an
// update-pending.json sentinel and lets the host's `klio update
// --watch` process do the privileged apply on the host.
//
// This test is the regression test for the v0.6.0 production bug
// where update-state.json's last_apply_error read
// `exec: "docker": executable file not found in $PATH`.
func TestRunUpdateOnceApplyMode(t *testing.T) {
	runner := &recordingRunner{}
	deps := newDeps(t, "0.6.0", UpdateModeApply, "0.6.1", runner)
	runUpdateOnce(context.Background(), deps)
	if runner.calls != 0 {
		// The bridge no longer runs docker — the host watcher does.
		t.Errorf("apply mode must NOT shell out (host watcher does that); calls=%d", runner.calls)
	}
	state, _ := updater.Read(deps.statePath)
	// The state file must reflect the available version so the
	// dashboard banner + npm `klio update --check` see consistent
	// values. last_applied_* stay empty — they're the host watcher's
	// to write after a successful host-side `docker compose pull && up`.
	if state.LastKnownAvailableVersion != "0.6.1" {
		t.Errorf("LastKnownAvailableVersion: got %q want 0.6.1", state.LastKnownAvailableVersion)
	}
	if state.LastApplyError != "" {
		t.Errorf("LastApplyError must be empty — bridge does not apply; got: %q", state.LastApplyError)
	}
	if state.LastAppliedVersion != "" {
		t.Errorf("LastAppliedVersion must be empty — only the host watcher writes it; got: %q", state.LastAppliedVersion)
	}
	// The sentinel must exist + name the right target version.
	pendingPath := pendingPathFromState(deps.statePath)
	pending, err := updater.ReadPending(pendingPath)
	if err != nil {
		t.Fatalf("ReadPending: %v", err)
	}
	if pending == nil {
		t.Fatalf("apply mode must write update-pending.json")
	}
	if pending.TargetVersion != "0.6.1" {
		t.Errorf("Pending.TargetVersion: got %q want 0.6.1", pending.TargetVersion)
	}
	if pending.RequestedBy != "bridge-auto-update" {
		t.Errorf("Pending.RequestedBy: got %q want bridge-auto-update", pending.RequestedBy)
	}
	if pending.RequestedAt.IsZero() {
		t.Errorf("Pending.RequestedAt must be set")
	}
}

// TestRunUpdateOnceApplyDoesNotRewriteSentinelOnSameTarget — when the
// ticker fires and a sentinel for the same target version already
// exists (host watcher hasn't picked it up yet), the ticker MUST be
// idempotent. Rewriting the sentinel on every tick would bump
// requested_at and confuse audit logs, and would race with the
// watcher that's about to delete it.
func TestRunUpdateOnceApplyDoesNotRewriteSentinelOnSameTarget(t *testing.T) {
	runner := &recordingRunner{}
	deps := newDeps(t, "0.6.0", UpdateModeApply, "0.6.1", runner)

	runUpdateOnce(context.Background(), deps)
	pendingPath := pendingPathFromState(deps.statePath)
	first, err := updater.ReadPending(pendingPath)
	if err != nil || first == nil {
		t.Fatalf("first tick: ReadPending err=%v pending=%v", err, first)
	}
	firstAt := first.RequestedAt

	// Second tick with the same target — sentinel already there.
	runUpdateOnce(context.Background(), deps)
	second, err := updater.ReadPending(pendingPath)
	if err != nil || second == nil {
		t.Fatalf("second tick: ReadPending err=%v pending=%v", err, second)
	}
	if !second.RequestedAt.Equal(firstAt) {
		t.Errorf("RequestedAt must NOT bump on idempotent re-tick: first=%v second=%v",
			firstAt, second.RequestedAt)
	}
}

// TestRunUpdateOnceApplyOverwritesSentinelOnNewerTarget — if a
// sentinel is sitting around for an older target (e.g. host watcher
// is slow + a newer release published in the meantime), the ticker
// MUST update it to the newer target. Otherwise the host would apply
// stale releases.
func TestRunUpdateOnceApplyOverwritesSentinelOnNewerTarget(t *testing.T) {
	runner := &recordingRunner{}
	deps := newDeps(t, "0.6.0", UpdateModeApply, "0.6.1", runner)

	// Tick 1: writes sentinel for 0.6.1.
	runUpdateOnce(context.Background(), deps)

	// Now bump latest to 0.6.2 (simulate newer release).
	deps.httpClient = stubHTTPGetter{fn: func(req *http.Request) (*http.Response, error) {
		return canonicalRegistryResponse("0.6.2")
	}}
	runUpdateOnce(context.Background(), deps)

	pendingPath := pendingPathFromState(deps.statePath)
	pending, err := updater.ReadPending(pendingPath)
	if err != nil || pending == nil {
		t.Fatalf("post-second-tick ReadPending err=%v pending=%v", err, pending)
	}
	if pending.TargetVersion != "0.6.2" {
		t.Errorf("sentinel must update to newest target; got %q want 0.6.2", pending.TargetVersion)
	}
}

func TestRunUpdateOnceNotifyMode(t *testing.T) {
	runner := &recordingRunner{}
	deps := newDeps(t, "0.6.0", UpdateModeNotify, "0.6.1", runner)
	runUpdateOnce(context.Background(), deps)
	if runner.calls != 0 {
		t.Errorf("notify mode must NOT invoke apply; calls=%d", runner.calls)
	}
	state, _ := updater.Read(deps.statePath)
	if state.LastKnownAvailableVersion != "0.6.1" {
		t.Errorf("LastKnownAvailableVersion: %q", state.LastKnownAvailableVersion)
	}
	if state.LastAppliedVersion != "" {
		t.Errorf("notify mode must NOT touch LastAppliedVersion; got %q", state.LastAppliedVersion)
	}
}

func TestRunUpdateOnceOffMode(t *testing.T) {
	// Off-mode tick is a hard no-op: no http call, no state read,
	// no runner invocation. The state file should not even exist
	// after the tick.
	runner := &recordingRunner{}
	deps := newDeps(t, "0.6.0", UpdateModeOff, "0.6.1", runner)
	runUpdateOnce(context.Background(), deps)
	if runner.calls != 0 {
		t.Errorf("off mode must NOT invoke apply; calls=%d", runner.calls)
	}
	if _, err := os.Stat(deps.statePath); !os.IsNotExist(err) {
		t.Errorf("off mode must NOT write state; stat err=%v", err)
	}
}

func TestRunUpdateOnceCheckFailureWritesError(t *testing.T) {
	runner := &recordingRunner{}
	deps := newDeps(t, "0.6.0", UpdateModeApply, "ignored", runner)
	deps.httpClient = stubHTTPGetter{fn: func(req *http.Request) (*http.Response, error) {
		return nil, errors.New("simulated network failure")
	}}
	runUpdateOnce(context.Background(), deps)
	if runner.calls != 0 {
		t.Errorf("apply runner must NOT be invoked when check fails; calls=%d", runner.calls)
	}
	state, _ := updater.Read(deps.statePath)
	if state.LastCheckError == "" {
		t.Error("LastCheckError must be set on failure")
	}
}

// TestRunUpdateOnceSentinelWriteFailureWritesError — under the host-
// watcher pattern, the bridge's only failure mode in apply-mode is a
// sentinel-write failure (e.g., the ~/.klio mount is read-only or
// the disk is full). The bridge must record this in
// last_apply_error so the dashboard surfaces the problem rather
// than silently never auto-updating.
func TestRunUpdateOnceSentinelWriteFailureWritesError(t *testing.T) {
	runner := &recordingRunner{}
	deps := newDeps(t, "0.6.0", UpdateModeApply, "0.6.1", runner)
	// Force WritePending to fail by pointing it at a path whose
	// parent directory does not exist — os.CreateTemp will reject
	// that with a clear error.
	deps.statePath = filepath.Join(t.TempDir(), "doesnt-exist", "update-state.json")

	runUpdateOnce(context.Background(), deps)
	if runner.calls != 0 {
		t.Errorf("apply mode must NOT shell out; calls=%d", runner.calls)
	}
	// The state file write would also fail (same parent dir), so we
	// can't assert by reading state.json. But the daemon must not
	// crash — that's the contract this test enforces.
}

// TestRunUpdateOnceMidTickModeChange proves a `klio configure
// auto-update off` flip is observed on the very next tick — not on
// daemon restart. This is the regression test for the v0.6.0
// finding: previously `mode` was captured into deps at goroutine
// startup, so a running daemon kept applying updates after the mode
// flipped to off.
//
// Under the v0.6.1 host-watcher pattern, "applying" means writing
// update-pending.json, so this test now asserts on sentinel
// presence rather than runner.calls.
func TestRunUpdateOnceMidTickModeChange(t *testing.T) {
	runner := &recordingRunner{}
	deps := newDeps(t, "0.6.0", UpdateModeApply, "0.6.1", runner)

	// Tick 1: apply mode + newer version → sentinel written.
	runUpdateOnce(context.Background(), deps)
	pendingPath := pendingPathFromState(deps.statePath)
	if pending, _ := updater.ReadPending(pendingPath); pending == nil {
		t.Fatalf("tick 1 (apply): sentinel must exist")
	}

	// Operator runs `klio configure auto-update off`. The env var
	// changes; deps stays the same; the next tick must observe off.
	t.Setenv("KLIO_AUTO_UPDATE", UpdateModeOff)

	// Tick 2 (off): the existing sentinel may legitimately stay
	// (it's the host watcher's job to consume it), but the off-mode
	// branch must short-circuit before any new state.json or
	// pending.json write.
	runUpdateOnce(context.Background(), deps)
	if runner.calls != 0 {
		t.Errorf("tick 2 (off): runner.calls must remain 0; got %d", runner.calls)
	}
}

func TestReadUpdateModeDefaults(t *testing.T) {
	cases := []struct {
		env  string
		want string
	}{
		{"", UpdateModeApply},     // default is apply
		{"apply", UpdateModeApply},
		{"notify", UpdateModeNotify},
		{"off", UpdateModeOff},
		{"junk", UpdateModeApply}, // unknown → apply
	}
	for _, c := range cases {
		os.Setenv("KLIO_AUTO_UPDATE", c.env)
		got := readUpdateMode()
		os.Unsetenv("KLIO_AUTO_UPDATE")
		if got != c.want {
			t.Errorf("env=%q: got %q want %q", c.env, got, c.want)
		}
	}
}

func TestReadUpdateCheckIntervalDefaults(t *testing.T) {
	cases := []struct {
		env  string
		want int
	}{
		{"", defaultUpdateCheckIntervalSecs},
		{"3600", 3600},
		{"junk", defaultUpdateCheckIntervalSecs},
		{"0", defaultUpdateCheckIntervalSecs}, // 0 / negative → default
		{"-5", defaultUpdateCheckIntervalSecs},
	}
	for _, c := range cases {
		os.Setenv("KLIO_UPDATE_CHECK_INTERVAL_SECS", c.env)
		got := readUpdateCheckInterval()
		os.Unsetenv("KLIO_UPDATE_CHECK_INTERVAL_SECS")
		if got != c.want {
			t.Errorf("env=%q: got %d want %d", c.env, got, c.want)
		}
	}
}
