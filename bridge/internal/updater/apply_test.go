package updater

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
)

// recordingRunner captures every Run() invocation for test inspection.
type recordingRunner struct {
	calls   []runnerCall
	pullErr error // returned on the first call (pull)
	upErr   error // returned on the second call (up)
}

type runnerCall struct {
	name string
	args []string
}

func (r *recordingRunner) Run(ctx context.Context, name string, args []string, log io.Writer) error {
	r.calls = append(r.calls, runnerCall{name: name, args: append([]string{}, args...)})
	if len(r.calls) == 1 {
		return r.pullErr
	}
	return r.upErr
}

func TestApplyHappyPath(t *testing.T) {
	rr := &recordingRunner{}
	err := Apply(context.Background(), rr, "/path/to/compose.yml", io.Discard)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(rr.calls) != 2 {
		t.Fatalf("expected 2 runner calls, got %d", len(rr.calls))
	}
	// Pull
	if rr.calls[0].name != "docker" {
		t.Errorf("pull cmd: %q", rr.calls[0].name)
	}
	pull := strings.Join(rr.calls[0].args, " ")
	if pull != "compose -f /path/to/compose.yml pull" {
		t.Errorf("pull args: %q", pull)
	}
	// Up
	if rr.calls[1].name != "docker" {
		t.Errorf("up cmd: %q", rr.calls[1].name)
	}
	up := strings.Join(rr.calls[1].args, " ")
	if up != "compose -f /path/to/compose.yml up -d --no-deps engine bridge trust-app" {
		t.Errorf("up args: %q", up)
	}
}

func TestApplyPullFailureSkipsUp(t *testing.T) {
	rr := &recordingRunner{pullErr: errors.New("rate-limited")}
	err := Apply(context.Background(), rr, "/x.yml", io.Discard)
	if err == nil {
		t.Fatal("expected error from failed pull, got nil")
	}
	if !strings.Contains(err.Error(), "pull") {
		t.Errorf("error must mention `pull`: %v", err)
	}
	if len(rr.calls) != 1 {
		t.Errorf("expected only 1 call (pull), got %d", len(rr.calls))
	}
}

func TestApplyUpFailureReturnsError(t *testing.T) {
	rr := &recordingRunner{upErr: errors.New("daemon unreachable")}
	err := Apply(context.Background(), rr, "/x.yml", io.Discard)
	if err == nil {
		t.Fatal("expected error from failed up, got nil")
	}
	if !strings.Contains(err.Error(), "up") {
		t.Errorf("error must mention `up`: %v", err)
	}
	if len(rr.calls) != 2 {
		t.Errorf("expected 2 calls (pull + up), got %d", len(rr.calls))
	}
}

func TestApplyContextCancellation(t *testing.T) {
	// The runner is responsible for honoring ctx; verify Apply
	// simply returns whatever the runner returns when the runner
	// surfaces a context-cancellation error.
	rr := &recordingRunner{pullErr: context.Canceled}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := Apply(ctx, rr, "/x.yml", io.Discard)
	if err == nil {
		t.Fatal("expected error on cancelled context, got nil")
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("expected context.Canceled in err chain: %v", err)
	}
}

func TestApplyWithServicesCustom(t *testing.T) {
	rr := &recordingRunner{}
	err := ApplyWithServices(context.Background(), rr, "/x.yml", "bridge", io.Discard)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	up := strings.Join(rr.calls[1].args, " ")
	if up != "compose -f /x.yml up -d --no-deps bridge" {
		t.Errorf("up args: %q", up)
	}
}

func TestSplitServices(t *testing.T) {
	cases := []struct {
		in  string
		out []string
	}{
		{"engine bridge trust-app", []string{"engine", "bridge", "trust-app"}},
		{"bridge", []string{"bridge"}},
		{"  spaces  around  ", []string{"spaces", "around"}},
		{"", []string{}},
		{"\tone\ttwo\t", []string{"one", "two"}},
	}
	for _, c := range cases {
		got := splitServices(c.in)
		if !slicesEqual(got, c.out) {
			t.Errorf("splitServices(%q): got %v want %v", c.in, got, c.out)
		}
	}
}

func slicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
