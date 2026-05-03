package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

// StepOllamaModel ensures `ollama` is installed and the requested
// embedding model is pulled. Optional: a missing or unreachable
// ollama is rendered as a yellow warning so klio init can still
// finish patching agent configs. The engine refuses writes that
// require embeddings until ollama is reachable, so the user gets a
// useful error from `recall` later if they skipped this step.
//
// We deliberately do NOT install ollama for the user — silent
// installation of a binary that listens on a network socket on the
// host crosses a trust line we don't want to cross. The warning
// includes copy-pasteable install commands instead.
func StepOllamaModel(model string) Step {
	return Step{
		Title:    fmt.Sprintf("Ensure embedding model %q is available via Ollama", model),
		Optional: true,
		Run: func(ctx context.Context, ui *UI) (string, bool, error) {
			path, err := exec.LookPath("ollama")
			if err != nil {
				return "", false, fmt.Errorf(
					"`ollama` not found on PATH — embeddings will be disabled until you install it. " +
						"Install:\n" +
						"  macOS:  brew install ollama && brew services start ollama\n" +
						"  Linux:  curl -fsSL https://ollama.com/install.sh | sh\n" +
						"  …or run with the docker-ollama compose profile (slower, CPU-only)",
				)
			}

			// `ollama list` doubles as a daemon-reachability probe AND
			// gives us the installed-model inventory in one call. Saves
			// us a separate `ps` ping.
			listOut, listErr := exec.CommandContext(ctx, path, "list").Output()
			if listErr != nil {
				return "", false, fmt.Errorf(
					"ollama is installed but the daemon is not reachable. "+
						"Start it with `brew services start ollama` (macOS) "+
						"or `systemctl --user start ollama` (Linux), then re-run klio init. "+
						"details: %v", listErr,
				)
			}

			if hasOllamaModel(string(listOut), model) {
				return "model already pulled", true, nil
			}

			ui.Info("pulling " + model + " (this can take 1-2 minutes on first run)")
			pull := exec.CommandContext(ctx, path, "pull", model)
			if err := streamCommand(ctx, ui, pull); err != nil {
				return "", false, fmt.Errorf("ollama pull %s: %w", model, err)
			}
			return "pulled " + model, false, nil
		},
	}
}

// hasOllamaModel parses the `ollama list` table for a given model
// name. The output looks like:
//
//	NAME                            ID              SIZE    MODIFIED
//	nomic-embed-text:latest         abcd1234        274 MB  3 days ago
//
// We strip Ollama's `:latest` tag for comparison so callers can pass
// either "nomic-embed-text" or "nomic-embed-text:latest" and get the
// same answer. We also strip the "ollama/" prefix users sometimes
// pass (matching the LiteLLM convention used elsewhere in Klio).
func hasOllamaModel(listOutput, model string) bool {
	want := strings.TrimPrefix(model, "ollama/")
	want = strings.TrimSuffix(want, ":latest")
	for _, line := range strings.Split(listOutput, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		got := strings.TrimSuffix(fields[0], ":latest")
		if got == want {
			return true
		}
	}
	return false
}

// StepWaitEngine polls /health on the engine URL until it returns
// 200 OK with status=ok, or the timeout elapses. Required: agent
// adapters wired in the next bootstrap phase point at the running
// engine, so a missing engine here would mean the user gets a
// "configured" Klio that fails on first MCP call.
func StepWaitEngine(url string, timeout time.Duration) Step {
	return Step{
		Title: "Wait for engine to become healthy at " + url,
		Run: func(ctx context.Context, ui *UI) (string, bool, error) {
			deadline := time.Now().Add(timeout)
			interval := 500 * time.Millisecond

			// We use a fresh client with a short per-request timeout so
			// a hung engine doesn't make the deadline-checking loop
			// itself hang past the requested timeout.
			client := &http.Client{Timeout: 2 * time.Second}

			lastErr := errors.New("not started")
			for time.Now().Before(deadline) {
				if err := ctx.Err(); err != nil {
					return "", false, err
				}

				ok, err := probeHealth(ctx, client, url)
				if ok {
					return url, false, nil
				}
				lastErr = err

				select {
				case <-ctx.Done():
					return "", false, ctx.Err()
				case <-time.After(interval):
				}
			}
			return "", false, fmt.Errorf(
				"engine did not become healthy within %s. last error: %v",
				timeout, lastErr,
			)
		},
	}
}

// probeHealth issues a single GET against url+"/health" and reports
// whether the response is 200 with `{"status":"ok"}`. Any non-2xx
// or transport error is treated as "not ready yet" rather than a
// hard failure — the polling loop will retry.
func probeHealth(ctx context.Context, client *http.Client, url string) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(url, "/")+"/health", nil)
	if err != nil {
		return false, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("status %d", resp.StatusCode)
	}
	var body struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return false, fmt.Errorf("decode /health: %w", err)
	}
	if body.Status != "ok" {
		return false, fmt.Errorf("status=%q (want ok)", body.Status)
	}
	return true, nil
}
