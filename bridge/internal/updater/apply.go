package updater

import (
	"context"
	"fmt"
	"io"
	"os/exec"
)

// Runner abstracts the os/exec layer so tests can stub the
// docker-compose invocations without spawning real processes.
//
// Production wires this to a thin shim around exec.CommandContext;
// tests inject a closure that records calls and returns canned
// outcomes.
type Runner interface {
	Run(ctx context.Context, name string, args []string, log io.Writer) error
}

// ExecRunner is the production Runner — it actually spawns
// processes. Stdout + stderr are merged into the supplied io.Writer
// so the daemon's structured log gets the full compose output.
type ExecRunner struct{}

// Run shells out to `name args...`. The merged stdout+stderr is
// streamed into log as it arrives. Exit code != 0 returns an error
// wrapping the command line for diagnostics.
func (ExecRunner) Run(ctx context.Context, name string, args []string, log io.Writer) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout = log
	cmd.Stderr = log
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s %v: %w", name, args, err)
	}
	return nil
}

// Apply runs `docker compose -f <composePath> pull` followed by
// `docker compose -f <composePath> up -d --no-deps engine bridge
// trust-app`. Both calls' stdout+stderr stream into log.
//
// On the recreate step, the bridge container that's executing
// this code is itself one of the recreated containers — the
// caller is expected to have written state to disk before
// invoking Apply. The new bridge starts on the new image, reads
// the persisted state, and continues normally.
func Apply(ctx context.Context, runner Runner, composePath string, log io.Writer) error {
	return ApplyWithServices(ctx, runner, composePath, "engine bridge trust-app", log)
}

// ApplyWithServices is Apply with an explicit space-separated
// service list. Exposed for tests; production callers use Apply.
func ApplyWithServices(ctx context.Context, runner Runner, composePath, services string, log io.Writer) error {
	pullArgs := []string{"compose", "-f", composePath, "pull"}
	if err := runner.Run(ctx, "docker", pullArgs, log); err != nil {
		return fmt.Errorf("docker compose pull: %w", err)
	}
	upArgs := []string{"compose", "-f", composePath, "up", "-d", "--no-deps"}
	for _, svc := range splitServices(services) {
		upArgs = append(upArgs, svc)
	}
	if err := runner.Run(ctx, "docker", upArgs, log); err != nil {
		return fmt.Errorf("docker compose up -d --no-deps: %w", err)
	}
	return nil
}

func splitServices(s string) []string {
	out := []string{}
	cur := ""
	for _, r := range s {
		if r == ' ' || r == '\t' {
			if cur != "" {
				out = append(out, cur)
				cur = ""
			}
			continue
		}
		cur += string(r)
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}
