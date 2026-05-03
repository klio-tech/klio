package orchestrator

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// StepFn executes a single step of the orchestration. It returns:
//
//   - status: a one-line summary printed next to the green check
//     ("started 4 services", "already healthy"). Empty becomes "done".
//   - skip:   true when the step was a no-op and should be rendered as
//     a dim "—" rather than a green check.
//   - err:    non-nil aborts Run, unless Step.Optional is set in which
//     case the error is rendered as a yellow warning and Run proceeds.
//
// Steps receive a UI handle so they can emit progress lines for
// long-running sub-operations (Docker pulls, Ollama model downloads).
type StepFn func(ctx context.Context, ui *UI) (status string, skip bool, err error)

// Step is the unit of work the runner consumes. Optional steps can
// fail without aborting the rest of the flow — used for ollama
// (engine still boots without it; embeddings simply won't work until
// ollama is installed).
type Step struct {
	Title    string
	Optional bool
	Run      StepFn
}

// Result captures what happened in a single Run() invocation, used
// by callers that want to render a summary or branch on outcome
// (e.g. main.go decides whether to print "next: klio daemon" only
// when the engine actually came up).
type Result struct {
	StepsRun     int
	StepsSkipped int
	StepsWarned  int
	Failed       *string // step title that failed; nil on success
}

// Run executes steps in order. Each step is wrapped in a timer; the
// elapsed time is shown next to the green check or yellow warning so
// users can spot slow steps without enabling debug logs.
//
// Cancellation: the context is passed through to every step. If the
// caller cancels, Run reports the cancelled step as the failure and
// returns immediately — partial work (containers started, hooks
// patched) is left in place rather than rolled back, on the same
// principle as `make` and `npm install` (don't auto-delete artifacts
// the user might want to inspect).
func Run(ctx context.Context, ui *UI, steps []Step) (*Result, error) {
	res := &Result{}
	for i := range steps {
		step := steps[i]
		ui.StartStep(step.Title)

		start := time.Now()
		status, skip, err := step.Run(ctx, ui)
		dur := time.Since(start)

		if err != nil {
			if step.Optional {
				ui.Warn(err.Error())
				res.StepsWarned++
				continue
			}
			ui.Fail(err)
			title := step.Title
			res.Failed = &title
			return res, fmt.Errorf("%s: %w", step.Title, err)
		}
		if skip {
			if status == "" {
				status = "skipped"
			}
			ui.Skip(status)
			res.StepsSkipped++
			continue
		}
		ui.OK(status, dur)
		res.StepsRun++
	}
	return res, nil
}

// ErrPreflight is returned by preflight steps when a hard requirement
// is missing on the host (Docker, dockerd reachable). Callers can
// branch on it to print install instructions vs. generic errors.
var ErrPreflight = errors.New("preflight failed")
