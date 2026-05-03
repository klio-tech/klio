package orchestrator

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// dockerComposeArgs returns the argv prefix for a working `docker
// compose` invocation, regardless of whether the host has the modern
// plugin (`docker compose`) or the legacy v1 binary (`docker-compose`).
//
// We return ("docker", ["compose"]) for the plugin and
// ("docker-compose", []) for v1. The order of preference is plugin
// first because that's the only path supported on Docker Desktop
// versions shipped after 2024 — v1 was deprecated and removed.
//
// errFn returned when neither is available.
func dockerComposeArgs() (cmd string, args []string, err error) {
	if path, err2 := exec.LookPath("docker"); err2 == nil {
		// Probe whether the compose plugin exists.
		probe := exec.Command(path, "compose", "version")
		if perr := probe.Run(); perr == nil {
			return "docker", []string{"compose"}, nil
		}
	}
	if _, err2 := exec.LookPath("docker-compose"); err2 == nil {
		return "docker-compose", nil, nil
	}
	return "", nil, errors.New(
		"docker compose not found — install Docker Desktop or the docker compose plugin",
	)
}

// StepDockerPreflight verifies docker is installed AND the daemon is
// reachable. Failure aborts the run with a clear instruction, because
// nothing else can succeed without docker (compose stack, engine, all
// downstream).
func StepDockerPreflight() Step {
	return Step{
		Title: "Check Docker is installed and running",
		Run: func(ctx context.Context, ui *UI) (string, bool, error) {
			docker, err := exec.LookPath("docker")
			if err != nil {
				return "", false, fmt.Errorf(
					"%w: `docker` not found on PATH. "+
						"Install Docker Desktop (https://www.docker.com/products/docker-desktop) "+
						"and re-run klio init",
					ErrPreflight,
				)
			}

			// `docker info` exits non-zero when the daemon is not
			// reachable — that's how we distinguish "Docker is
			// installed" from "Docker is running".
			out, runErr := exec.CommandContext(ctx, docker, "info", "--format", "{{.ServerVersion}}").CombinedOutput()
			if runErr != nil {
				return "", false, fmt.Errorf(
					"%w: Docker daemon is not running. "+
						"Open Docker Desktop (or run `systemctl start docker`) and re-run klio init.\n"+
						"  details: %s",
					ErrPreflight, strings.TrimSpace(string(out)),
				)
			}
			version := strings.TrimSpace(string(out))
			if version == "" {
				version = "ready"
			}
			return "docker " + version, false, nil
		},
	}
}

// StepComposeUp brings up the named services from the compose file
// found by walking up from `cwd`. If the stack is already running with
// matching config, `docker compose up -d` is a fast no-op (no rebuild,
// no restart) — we still mark it run rather than skip because compose
// itself reports "Started" lines we want surfaced.
//
// Why we don't pre-detect "already up": compose's own logic accounts
// for image changes, env changes, and volume drift. Re-implementing
// that here would be brittle; better to let compose do its own diff.
//
// findRoot is the function used to locate the compose file. In tests
// we pass a stub that points at a fixture; the runtime caller passes
// bootstrap.FindKlioProjectRoot.
func StepComposeUp(cwd string, services []string, findRoot func(string) string) Step {
	return Step{
		Title: "Start postgres + redis + engine (docker compose up -d)",
		Run: func(ctx context.Context, ui *UI) (string, bool, error) {
			root := findRoot(cwd)
			if root == "" {
				return "", false, errors.New(
					"no docker-compose.yml found in this directory or any parent — " +
						"run klio init from inside the klio repo, or set KLIO_COMPOSE_DIR " +
						"to a directory containing klio's docker-compose.yml",
				)
			}

			cmd, prefix, err := dockerComposeArgs()
			if err != nil {
				return "", false, err
			}
			argv := append([]string{}, prefix...)
			argv = append(argv, "up", "-d")
			argv = append(argv, services...)

			c := exec.CommandContext(ctx, cmd, argv...)
			c.Dir = root
			c.Env = os.Environ()

			if err := streamCommand(ctx, ui, c); err != nil {
				return "", false, fmt.Errorf("docker compose up failed: %w", err)
			}
			return fmt.Sprintf("started %d service(s) from %s", len(services), filepath.Base(root)), false, nil
		},
	}
}

// streamCommand runs c, forwarding stderr lines to ui.Info as they
// arrive. We don't bother with stdout because compose writes its
// progress to stderr (TTY users see the same lines on the host
// terminal).
//
// Returns the underlying exec error so callers can wrap it. The
// captured tail of stderr is appended to the error for context when
// the command fails fast (e.g. "no such service").
func streamCommand(ctx context.Context, ui *UI, c *exec.Cmd) error {
	stderr, err := c.StderrPipe()
	if err != nil {
		return err
	}
	c.Stdout = io.Discard

	if err := c.Start(); err != nil {
		return err
	}

	var tail bytes.Buffer
	scanner := bufio.NewScanner(stderr)
	for scanner.Scan() {
		line := scanner.Text()
		ui.Info(line)
		// Keep the last ~2KB so error messages can include recent
		// context without unbounded memory growth on long pulls.
		if tail.Len() < 2048 {
			tail.WriteString(line)
			tail.WriteByte('\n')
		}
	}

	if err := c.Wait(); err != nil {
		return fmt.Errorf("%w\n%s", err, strings.TrimSpace(tail.String()))
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return nil
}
