package daemon

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/klio-tech/bridge/internal/updater"
)

// Updater modes — match the npm CLI's `klio configure auto-update` choices.
const (
	UpdateModeApply  = "apply"
	UpdateModeNotify = "notify"
	UpdateModeOff    = "off"
)

// Default ticker interval if KLIO_UPDATE_CHECK_INTERVAL_SECS is unset / invalid.
const defaultUpdateCheckIntervalSecs = 21600 // 6 hours

// Default state-file path inside the bridge container. Compose mounts
// the host's ~/.klio at /host/.klio (added in B1). The bridge writes
// here on every tick.
const defaultUpdateStatePath = "/host/.klio/update-state.json"

// updateTickerDeps factors out the side-effect surfaces so tests can
// stub them. Production wires httpClient = updater.DefaultClient(),
// runner = updater.ExecRunner{}, log = a slog-bound writer.
//
// Note: the auto-update mode is intentionally NOT stored on deps.
// `runUpdateOnce` re-reads it from the env on every tick so a
// `klio configure auto-update <mode>` change takes effect on the
// next tick without a daemon restart. The ticker interval IS still
// captured at startup because changing it would require recreating
// the time.Ticker — that's a follow-up; per-tick mode re-read is
// sufficient to make the configure command non-silent.
type updateTickerDeps struct {
	statePath      string
	composePath    string
	currentVersion string
	httpClient     updater.HTTPGetter
	runner         updater.Runner
	log            io.Writer

	// mu guards the in-flight flag to prevent overlapping ticks.
	mu       sync.Mutex
	inFlight bool
}

// runUpdaterTicker is the daemon's periodic auto-update job. The
// loop fires every KLIO_UPDATE_CHECK_INTERVAL_SECS (default 21600 = 6h)
// and:
//  1. Reads the on-disk state file (creating a fresh State if missing).
//  2. Hits the npm registry for the latest published version.
//  3. If a newer version exists AND mode == "apply", shells out to
//     `docker compose pull && up -d --no-deps engine bridge trust-app`.
//  4. Persists the outcome back to the state file.
//
// The mode is re-read from the env on every tick inside `runUpdateOnce`
// so `klio configure auto-update <mode>` takes effect on the next tick
// without a daemon restart. When the operator flips to `off`, the
// ticker keeps firing but each tick observes the off mode and returns
// immediately — a tiny, predictable cost in exchange for a one-line
// fix that makes the configure command non-silent.
//
// We still consult the mode at startup for the boot-time log line so
// operators can see what mode the daemon woke up in.
func (d *Daemon) runUpdaterTicker(ctx context.Context) {
	interval := readUpdateCheckInterval()
	deps := &updateTickerDeps{
		statePath:      readUpdateStatePath(),
		composePath:    readComposePath(),
		currentVersion: readCurrentVersion(),
		httpClient:     updater.DefaultClient(),
		runner:         updater.ExecRunner{},
		log:            slogWriter{},
	}
	slog.Info("updater: starting ticker",
		"mode", readUpdateMode(),
		"interval_secs", interval,
		"state_path", deps.statePath,
		"current_version", deps.currentVersion,
	)

	// First tick fires immediately on goroutine entry — same shape as
	// subscribeAccessibleSpaces. Subsequent ticks happen on the
	// interval boundary.
	runUpdateOnce(ctx, deps)
	t := newTicker(interval)
	defer t.stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.tick():
			runUpdateOnce(ctx, deps)
		}
	}
}

// runUpdateOnce executes one iteration of the ticker. Public-style
// signature (top-level package func, takes deps explicitly) so tests
// can drive it without spinning up a full *Daemon.
//
// Single-flight: if a tick is already in flight (slow npm-registry
// response, slow compose pull), a second invocation is a no-op.
// Both APScheduler-equivalent timer semantics AND the curator's
// per-user lock hold up — but the auto-updater takes its own lock
// here for belt-and-suspenders.
func runUpdateOnce(ctx context.Context, deps *updateTickerDeps) {
	// Re-read the mode every tick so a `klio configure auto-update`
	// flip takes effect on the next tick without a daemon restart.
	// Storing it on deps would freeze the value at goroutine startup —
	// the bug fixed here in v0.6.0.
	mode := readUpdateMode()
	if mode == UpdateModeOff {
		// Off-mode tick is a no-op. The ticker keeps running so a
		// later flip back to apply/notify is observed promptly; the
		// per-tick cost is one env read.
		return
	}

	deps.mu.Lock()
	if deps.inFlight {
		deps.mu.Unlock()
		slog.Debug("updater: tick already in flight, skipping")
		return
	}
	deps.inFlight = true
	deps.mu.Unlock()
	defer func() {
		deps.mu.Lock()
		deps.inFlight = false
		deps.mu.Unlock()
	}()

	state, err := updater.Read(deps.statePath)
	if err != nil {
		slog.Warn("updater: read state failed", "err", err)
		return
	}
	if state.CurrentVersion == "" {
		state.CurrentVersion = deps.currentVersion
	}

	// 1. Check the registry.
	latest, checkErr := updater.Check(ctx, deps.httpClient)
	state.LastCheckAt = time.Now().UTC()
	if checkErr != nil {
		state.LastCheckError = checkErr.Error()
		if writeErr := updater.Write(deps.statePath, state); writeErr != nil {
			slog.Warn("updater: write state failed", "err", writeErr)
		}
		return
	}
	state.LastCheckError = "" // clear on success

	if !updater.IsNewer(deps.currentVersion, latest) {
		// No newer version. Persist the check timestamp + current
		// known-available so dashboards see a fresh heartbeat.
		state.LastKnownAvailableVersion = deps.currentVersion
		_ = updater.Write(deps.statePath, state)
		return
	}

	// 2. Newer version available.
	state.LastKnownAvailableVersion = latest

	if mode != UpdateModeApply {
		// Notify-only: persist + return. Dashboard banner reads
		// last_known_available_version.
		_ = updater.Write(deps.statePath, state)
		return
	}

	// 3. Apply mode: shell out to compose.
	if err := updater.Apply(ctx, deps.runner, deps.composePath, deps.log); err != nil {
		state.LastApplyError = err.Error()
		_ = updater.Write(deps.statePath, state)
		slog.Warn("updater: apply failed", "err", err)
		return
	}

	// 4. Apply succeeded.
	state.LastAppliedVersion = latest
	state.LastAppliedAt = time.Now().UTC()
	state.LastApplyError = "" // clear on success
	if err := updater.Write(deps.statePath, state); err != nil {
		slog.Warn("updater: write state after apply failed", "err", err)
	}
	slog.Info("updater: applied", "version", latest)
}

// --- env readers ---

func readUpdateMode() string {
	v := os.Getenv("KLIO_AUTO_UPDATE")
	switch v {
	case UpdateModeApply, UpdateModeNotify, UpdateModeOff:
		return v
	case "":
		return UpdateModeApply // default
	default:
		slog.Warn("updater: unknown KLIO_AUTO_UPDATE value, defaulting to apply", "value", v)
		return UpdateModeApply
	}
}

func readUpdateCheckInterval() int {
	raw := os.Getenv("KLIO_UPDATE_CHECK_INTERVAL_SECS")
	if raw == "" {
		return defaultUpdateCheckIntervalSecs
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		slog.Warn("updater: bad KLIO_UPDATE_CHECK_INTERVAL_SECS, using default", "raw", raw)
		return defaultUpdateCheckIntervalSecs
	}
	return n
}

func readUpdateStatePath() string {
	if v := os.Getenv("KLIO_UPDATE_STATE_PATH"); v != "" {
		return v
	}
	return defaultUpdateStatePath
}

func readComposePath() string {
	if v := os.Getenv("KLIO_COMPOSE_PATH"); v != "" {
		return v
	}
	// Mounted at /host/.klio/docker-compose.yml in production via the
	// ~/.klio mount added in B1.
	return filepath.Join("/host/.klio", "docker-compose.yml")
}

func readCurrentVersion() string {
	if v := os.Getenv("KLIO_BRIDGE_VERSION"); v != "" {
		return v
	}
	return "0.0.0-dev"
}

// slogWriter is an io.Writer that pipes compose stdout/stderr lines
// into slog at INFO level. Each Write is treated as one log line
// (compose interleaves multi-line output but slog's INFO is the
// right severity — this is operator-facing).
type slogWriter struct{}

func (slogWriter) Write(p []byte) (int, error) {
	if len(p) > 0 {
		// Trim trailing newline for cleaner log output.
		s := string(p)
		if s[len(s)-1] == '\n' {
			s = s[:len(s)-1]
		}
		slog.Info("compose", "line", s)
	}
	return len(p), nil
}
