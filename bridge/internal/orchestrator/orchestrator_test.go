package orchestrator

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newBufferUI() (*UI, *bytes.Buffer) {
	buf := &bytes.Buffer{}
	return &UI{Out: buf, Color: false}, buf
}

func TestRun_AllStepsSucceed(t *testing.T) {
	ui, buf := newBufferUI()
	steps := []Step{
		{Title: "first", Run: func(_ context.Context, _ *UI) (string, bool, error) {
			return "ready", false, nil
		}},
		{Title: "second", Run: func(_ context.Context, _ *UI) (string, bool, error) {
			return "5 things", false, nil
		}},
	}
	res, err := Run(context.Background(), ui, steps)
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if res.StepsRun != 2 || res.StepsSkipped != 0 || res.StepsWarned != 0 {
		t.Errorf("res = %+v want StepsRun=2", res)
	}
	out := buf.String()
	for _, want := range []string{"▸ first", "▸ second", "✓ ready", "✓ 5 things"} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q:\n%s", want, out)
		}
	}
}

func TestRun_SkipStepsRenderDimmed(t *testing.T) {
	ui, buf := newBufferUI()
	steps := []Step{
		{Title: "noop", Run: func(_ context.Context, _ *UI) (string, bool, error) {
			return "already running", true, nil
		}},
	}
	res, err := Run(context.Background(), ui, steps)
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if res.StepsSkipped != 1 || res.StepsRun != 0 {
		t.Errorf("res = %+v want StepsSkipped=1", res)
	}
	if !strings.Contains(buf.String(), "— already running") {
		t.Errorf("missing skip line:\n%s", buf.String())
	}
}

func TestRun_OptionalStepFailureBecomesWarning(t *testing.T) {
	ui, buf := newBufferUI()
	steps := []Step{
		{Title: "ollama", Optional: true, Run: func(_ context.Context, _ *UI) (string, bool, error) {
			return "", false, errors.New("not installed")
		}},
		{Title: "next", Run: func(_ context.Context, _ *UI) (string, bool, error) {
			return "ok", false, nil
		}},
	}
	res, err := Run(context.Background(), ui, steps)
	if err != nil {
		t.Fatalf("Run should not fail when only optional step errored: %v", err)
	}
	if res.StepsWarned != 1 || res.StepsRun != 1 {
		t.Errorf("res = %+v want StepsWarned=1 StepsRun=1", res)
	}
	out := buf.String()
	if !strings.Contains(out, "! not installed") {
		t.Errorf("missing warning marker:\n%s", out)
	}
	if !strings.Contains(out, "✓ ok") {
		t.Errorf("subsequent step did not run after optional failure:\n%s", out)
	}
}

func TestRun_RequiredStepFailureAbortsRun(t *testing.T) {
	ui, buf := newBufferUI()
	calls := 0
	steps := []Step{
		{Title: "first", Run: func(_ context.Context, _ *UI) (string, bool, error) {
			calls++
			return "ok", false, nil
		}},
		{Title: "blocker", Run: func(_ context.Context, _ *UI) (string, bool, error) {
			return "", false, errors.New("docker is dead")
		}},
		{Title: "never", Run: func(_ context.Context, _ *UI) (string, bool, error) {
			t.Fatalf("third step should not run after required failure")
			return "", false, nil
		}},
	}
	res, err := Run(context.Background(), ui, steps)
	if err == nil {
		t.Fatalf("Run should have errored")
	}
	if !strings.Contains(err.Error(), "docker is dead") {
		t.Errorf("err = %v want it to wrap the underlying message", err)
	}
	if res.Failed == nil || *res.Failed != "blocker" {
		t.Errorf("res.Failed = %v want \"blocker\"", res.Failed)
	}
	if calls != 1 {
		t.Errorf("first step ran %d times, want 1", calls)
	}
	if !strings.Contains(buf.String(), "✗ docker is dead") {
		t.Errorf("missing fail marker:\n%s", buf.String())
	}
}

func TestRun_CancellationStopsAtCurrentStep(t *testing.T) {
	ui, _ := newBufferUI()
	ctx, cancel := context.WithCancel(context.Background())
	steps := []Step{
		{Title: "cancellable", Run: func(c context.Context, _ *UI) (string, bool, error) {
			cancel()
			<-c.Done()
			return "", false, c.Err()
		}},
		{Title: "never", Run: func(_ context.Context, _ *UI) (string, bool, error) {
			t.Fatalf("subsequent step ran after cancellation")
			return "", false, nil
		}},
	}
	_, err := Run(ctx, ui, steps)
	if !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v want wraps context.Canceled", err)
	}
}

func TestProbeHealth_OK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","version":"x"}`))
	}))
	defer srv.Close()

	ok, err := probeHealth(context.Background(), srv.Client(), srv.URL)
	if !ok || err != nil {
		t.Errorf("probeHealth = (%v, %v) want (true, nil)", ok, err)
	}
}

func TestProbeHealth_NotOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(503)
	}))
	defer srv.Close()
	ok, err := probeHealth(context.Background(), srv.Client(), srv.URL)
	if ok || err == nil {
		t.Errorf("probeHealth = (%v, %v) want (false, non-nil)", ok, err)
	}
}

func TestStepWaitEngine_TimesOutWhenNoServer(t *testing.T) {
	step := StepWaitEngine("http://127.0.0.1:1", 250*time.Millisecond)
	ui, _ := newBufferUI()
	_, _, err := step.Run(context.Background(), ui)
	if err == nil {
		t.Fatalf("expected timeout error")
	}
	if !strings.Contains(err.Error(), "did not become healthy") {
		t.Errorf("err = %v want timeout phrasing", err)
	}
}

func TestStepWaitEngine_SucceedsAgainstFakeServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			_, _ = w.Write([]byte(`{"status":"ok"}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	step := StepWaitEngine(srv.URL, 3*time.Second)
	ui, _ := newBufferUI()
	status, _, err := step.Run(context.Background(), ui)
	if err != nil {
		t.Fatalf("step failed: %v", err)
	}
	if status != srv.URL {
		t.Errorf("status = %q want %q", status, srv.URL)
	}
}

func TestHasOllamaModel(t *testing.T) {
	output := `NAME                       ID            SIZE    MODIFIED
nomic-embed-text:latest    abcd1234      274 MB  3 days ago
llama3:latest              ef567890      4.7 GB  1 week ago
`
	cases := []struct {
		query string
		want  bool
	}{
		{"nomic-embed-text", true},
		{"nomic-embed-text:latest", true},
		{"ollama/nomic-embed-text", true},
		{"llama3", true},
		{"snowflake-arctic-embed2", false},
		{"", false},
	}
	for _, c := range cases {
		if got := hasOllamaModel(output, c.query); got != c.want {
			t.Errorf("hasOllamaModel(%q) = %v want %v", c.query, got, c.want)
		}
	}
}

func TestFormatDur(t *testing.T) {
	cases := []struct {
		d    time.Duration
		want string
	}{
		{500 * time.Millisecond, "500ms"},
		{1500 * time.Millisecond, "1.5s"},
		{2 * time.Minute, "2m0s"},
		{2*time.Minute + 30*time.Second, "2m30s"},
	}
	for _, c := range cases {
		if got := formatDur(c.d); got != c.want {
			t.Errorf("formatDur(%v) = %q want %q", c.d, got, c.want)
		}
	}
}
