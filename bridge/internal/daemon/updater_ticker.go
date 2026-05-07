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
	"github.com/klio-tech/bridge/internal/version"
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

// pendingFilename is the sibling-of-update-state.json sentinel the
// bridge writes when an apply-eligible update is detected. The host's
// `klio update --watch` polls for this filename; both the bridge
// (writer) and the host watcher (reader/deleter) MUST agree on it.
//
// Centralised here so a future rename can't drift the two surfaces
// apart.
const pendingFilename = "update-pending.json"

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

	// 3. Apply mode: write update-pending.json so the host's
	//    `klio update --watch` can run `docker compose pull && up -d`
	//    on the host. The bridge cannot do this itself — its
	//    container has no docker CLI, and giving it one would force
	//    docker-in-docker or a privileged docker.sock mount, both of
	//    which are unacceptable security postures.
	//
	//    We write the sentinel ONLY when its target_version differs
	//    from what's already on disk: rewriting on every tick would
	//    bump requested_at and confuse audit logs (and race with the
	//    watcher that's about to delete the sentinel after a
	//    successful apply).
	pendingPath := pendingPathFromState(deps.statePath)
	existing, _ := updater.ReadPending(pendingPath)
	if existing == nil || existing.TargetVersion != latest {
		pending := updater.Pending{
			TargetVersion: latest,
			RequestedAt:   time.Now().UTC(),
			RequestedBy:   "bridge-auto-update",
			ComposePath:   deps.composePath,
		}
		if err := updater.WritePending(pendingPath, pending); err != nil {
			state.LastApplyError = "write pending: " + err.Error()
			_ = updater.Write(deps.statePath, state)
			slog.Warn("updater: write pending failed", "err", err)
			return
		}
		slog.Info("updater: wrote update-pending sentinel",
			"target_version", latest, "path", pendingPath)
	}

	// 4. Persist the heartbeat: latest seen, no apply-error from
	//    the bridge's side (host-side errors are the watcher's to
	//    surface). last_applied_* are written by the host watcher
	//    after a successful apply, NOT here.
	state.LastApplyError = "" // clear on success — bridge write succeeded
	if err := updater.Write(deps.statePath, state); err != nil {
		slog.Warn("updater: write state after sentinel failed", "err", err)
	}
}

// pendingPathFromState derives the absolute path to update-pending.json
// from the absolute path to update-state.json. The two files live in
// the same directory (~/.klio inside the bridge container's
// /host/.klio mount), so they share the parent dir.
//
// Centralising this resolution here means the ticker AND the test
// helpers compute the same path — a hand-spelled "/host/.klio/update-
// pending.json" string in either side would silently drift if
// KLIO_UPDATE_STATE_PATH ever overrode the default.
func pendingPathFromState(statePath string) string {
	return filepath.Join(filepath.Dir(statePath), pendingFilename)
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

// readCurrentVersion delegates to the bridge's single source of truth
// for its build version. The resolution order (file → env → default)
// lives in `internal/version`; see that package's doc comment for the
// rationale on why the file beats the env.
//
// We keep this thin wrapper rather than calling `version.Get()`
// directly at the call site to give the test suite an obvious local
// override seam: a future regression test of the ticker doesn't need
// to mock /etc/klio-version, it shadows this function (or, more
// directly, sets `deps.currentVersion` on a `newDeps` build).
func readCurrentVersion() string {
	return version.Get()
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
