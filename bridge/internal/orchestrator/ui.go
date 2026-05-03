// Package orchestrator runs the `klio init` infrastructure flow:
// preflighting the host, bringing up the docker stack, ensuring an
// embedding model is reachable, and waiting for the engine to become
// healthy. Account provisioning + agent wiring (the user-visible
// "Klio is set up." line) lives in package bootstrap and runs after
// this package's steps complete.
//
// The split exists because infrastructure orchestration and account
// management have different failure modes, idempotency rules, and
// external dependencies. Mixing them in one runner forces every test
// to mock both Docker and the cloud API.
package orchestrator

import (
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// UI is a tiny printer that produces the structured progress lines
// klio init emits. It buffers nothing — every method writes
// immediately so users see progress as it happens (Docker pulls and
// Ollama model pulls can take 10–60s and we don't want a silent CLI).
//
// Colour is enabled when stdout is a TTY and NO_COLOR is unset (the
// de-facto cross-tool standard). Tests construct a UI with Color=false
// to make output deterministic.
type UI struct {
	Out   io.Writer
	Color bool
}

// NewUI returns a UI bound to stdout with auto-detected colour.
func NewUI() *UI {
	return &UI{
		Out:   os.Stdout,
		Color: shouldColor(),
	}
}

// shouldColor returns true when ANSI colour escapes are appropriate.
// Disabled if:
//   - NO_COLOR is set (any value) — https://no-color.org
//   - stdout is not a character device (pipe, file, CI buffer)
//
// Tested implicitly by the orchestrator integration tests, which
// route Out into a bytes.Buffer (not a TTY) and assert plain text.
func shouldColor() bool {
	if os.Getenv("NO_COLOR") != "" {
		return false
	}
	info, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

const (
	ansiReset  = "\x1b[0m"
	ansiDim    = "\x1b[2m"
	ansiGreen  = "\x1b[32m"
	ansiRed    = "\x1b[31m"
	ansiYellow = "\x1b[33m"
	ansiCyan   = "\x1b[36m"
	ansiBold   = "\x1b[1m"
)

func (u *UI) paint(code, s string) string {
	if !u.Color {
		return s
	}
	return code + s + ansiReset
}

// Banner prints the header shown once at the start of klio init.
func (u *UI) Banner(text string) {
	fmt.Fprintln(u.Out, u.paint(ansiBold, text))
	fmt.Fprintln(u.Out)
}

// StartStep prints "▸ <title>…" — call before the step runs.
func (u *UI) StartStep(title string) {
	fmt.Fprintf(u.Out, "%s %s…\n", u.paint(ansiCyan, "▸"), title)
}

// OK closes a step with "  ✓ <status> (1.2s)".
func (u *UI) OK(status string, dur time.Duration) {
	prefix := u.paint(ansiGreen, "  ✓")
	d := u.paint(ansiDim, "("+formatDur(dur)+")")
	if status == "" {
		fmt.Fprintf(u.Out, "%s done %s\n", prefix, d)
	} else {
		fmt.Fprintf(u.Out, "%s %s %s\n", prefix, status, d)
	}
}

// Skip closes a step that was a no-op (e.g. compose stack already up).
func (u *UI) Skip(reason string) {
	fmt.Fprintf(u.Out, "%s %s\n", u.paint(ansiDim, "  —"), u.paint(ansiDim, reason))
}

// Warn closes a step that succeeded with caveats (e.g. ollama not
// installed; embeddings disabled). Doesn't abort the run.
func (u *UI) Warn(message string) {
	fmt.Fprintf(u.Out, "%s %s\n", u.paint(ansiYellow, "  !"), message)
}

// Fail closes a step that failed.
func (u *UI) Fail(err error) {
	fmt.Fprintf(u.Out, "%s %s\n", u.paint(ansiRed, "  ✗"), err.Error())
}

// Info prints a dim secondary line under the current step. Use for
// long-running progress notes ("pulling pgvector/pgvector:pg16…").
func (u *UI) Info(line string) {
	for _, l := range strings.Split(line, "\n") {
		if l == "" {
			continue
		}
		fmt.Fprintf(u.Out, "%s %s\n", u.paint(ansiDim, "    ·"), u.paint(ansiDim, l))
	}
}

// formatDur renders durations as "320ms", "1.2s", "1m4s" — short
// enough to fit at the end of a status line, precise enough to be
// useful when troubleshooting slow pulls or migrations.
func formatDur(d time.Duration) string {
	if d < time.Second {
		return fmt.Sprintf("%dms", d.Milliseconds())
	}
	if d < time.Minute {
		return fmt.Sprintf("%.1fs", d.Seconds())
	}
	m := int(d / time.Minute)
	s := int((d % time.Minute) / time.Second)
	return fmt.Sprintf("%dm%ds", m, s)
}
