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

func TestRunUpdateOnceApplyMode(t *testing.T) {
	runner := &recordingRunner{}
	deps := newDeps(t, "0.6.0", UpdateModeApply, "0.6.1", runner)
	runUpdateOnce(context.Background(), deps)
	if runner.calls != 2 {
		// Pull + Up = 2 runner calls.
		t.Errorf("expected 2 runner calls (pull+up), got %d", runner.calls)
	}
	state, _ := updater.Read(deps.statePath)
	if state.LastAppliedVersion != "0.6.1" {
		t.Errorf("LastAppliedVersion: %q", state.LastAppliedVersion)
	}
	if state.LastApplyError != "" {
		t.Errorf("LastApplyError unexpected: %q", state.LastApplyError)
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

func TestRunUpdateOnceApplyFailureWritesError(t *testing.T) {
	runner := &recordingRunner{err: errors.New("rate-limited")}
	deps := newDeps(t, "0.6.0", UpdateModeApply, "0.6.1", runner)
	runUpdateOnce(context.Background(), deps)
	state, _ := updater.Read(deps.statePath)
	if state.LastApplyError == "" {
		t.Error("LastApplyError must be set on failure")
	}
	if state.LastAppliedVersion != "" {
		t.Errorf("LastAppliedVersion must NOT advance on failure; got %q", state.LastAppliedVersion)
	}
}

// TestRunUpdateOnceMidTickModeChange proves a `klio configure
// auto-update off` flip is observed on the very next tick — not on
// daemon restart. This is the regression test for the v0.6.0
// finding: previously `mode` was captured into deps at goroutine
// startup, so a running daemon kept applying updates after the mode
// flipped to off.
func TestRunUpdateOnceMidTickModeChange(t *testing.T) {
	runner := &recordingRunner{}
	deps := newDeps(t, "0.6.0", UpdateModeApply, "0.6.1", runner)

	// Tick 1: apply mode + newer version → pull + up = 2 runner calls.
	runUpdateOnce(context.Background(), deps)
	if runner.calls != 2 {
		t.Fatalf("tick 1 (apply): expected 2 runner calls, got %d", runner.calls)
	}

	// Mid-run: operator runs `klio configure auto-update off`. The
	// env var changes; deps stays the same; the running daemon must
	// observe the new mode on the very next tick.
	t.Setenv("KLIO_AUTO_UPDATE", UpdateModeOff)

	// Tick 2: off mode → no NEW runner calls (count must stay at 2).
	runUpdateOnce(context.Background(), deps)
	if runner.calls != 2 {
		t.Errorf("tick 2 (off): runner.calls must stay at 2 (mid-run flip ignored?); got %d", runner.calls)
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
