package updater

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Pending is the on-disk shape of update-pending.json — the sentinel
// the bridge writes when it has detected an apply-eligible update
// and wants the host's `klio update --watch` process to run the
// actual `docker compose pull && up -d` on the host.
//
// Why a separate file from update-state.json: state.json is a
// long-lived status surface (engine + trust-app + npm CLI all read
// it). pending.json is an ephemeral request — it appears on detection,
// disappears on apply or dismissal. Mixing the two would couple the
// "current status" and "in-flight request" lifecycles in a way that
// makes both harder to reason about.
//
// Why the bridge can't apply directly: the bridge container has no
// `docker` CLI inside it, and giving it one would mean either
// docker-in-docker (security disaster) or mounting /var/run/docker.sock
// into the bridge (effectively a root-on-host privilege escalation
// for any code running in the bridge). The sentinel-and-watcher
// pattern keeps the bridge confined to its own filesystem and lets
// the host's klio CLI — which the user already trusts to run docker
// — do the privileged work.
//
// Field naming follows update-state.json's snake_case convention so
// users hand-inspecting both files don't context-switch.
type Pending struct {
	// TargetVersion is the @klio-tech/klio version the bridge wants
	// the host to pull and recreate the stack onto. The host watcher
	// MUST NOT trust this without semver-validating: the bridge writes
	// it after checking npm but a compromised bridge could otherwise
	// pin the user's stack to an attacker-controlled tag.
	TargetVersion string `json:"target_version"`

	// RequestedAt is the wall-clock when the bridge wrote this
	// sentinel. The host watcher logs it so users can correlate a
	// "klio updated overnight" surprise with the sentinel timestamp.
	RequestedAt time.Time `json:"requested_at"`

	// RequestedBy is a free-form audit string identifying the writer.
	// The bridge ticker sets it to "bridge-auto-update". If a future
	// surface (e.g., the trust-app dashboard's "update now" button)
	// learns to write this file, it sets a different value here so
	// the host's audit log can attribute the request to a UI vs the
	// background ticker.
	RequestedBy string `json:"requested_by,omitempty"`

	// ComposePath is the absolute path on the HOST filesystem (not the
	// bridge's view) of docker-compose.yml. The bridge knows this
	// because it reads /host/.klio/docker-compose.yml — the host path
	// is reconstructible from KLIO_HOST_KLIO_DIR (a future enhancement;
	// for v0.6.1 the watcher resolves its own composePath from
	// runtimeDir() and ignores this field, but we serialize it anyway
	// for forward-compat).
	ComposePath string `json:"compose_path,omitempty"`
}

// WritePending atomically writes p to path with mode 0644.
//
// The atomicity contract matches state.go's Write: a concurrent
// reader observes either the previous file or the new one in full,
// never a partially-written file. This matters because the host
// watcher polls on a fixed interval and a partial-read would surface
// as a parse error and mask the real intent.
func WritePending(path string, p Pending) error {
	bytes, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal pending: %w", err)
	}
	bytes = append(bytes, '\n')
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".update-pending.*.tmp")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	if _, err := tmp.Write(bytes); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write temp: %w", err)
	}
	if err := tmp.Chmod(0o644); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("chmod temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

// ReadPending returns the parsed sentinel at path, or (nil, nil) if
// the file does not exist. Other errors (corrupt JSON, permission)
// are surfaced verbatim so the watcher can log them rather than
// silently treating "broken" as "absent".
//
// Returning a pointer (rather than a Pending value) is deliberate:
// the watcher's poll loop wants a clear three-state result —
// no-pending / parse-error / pending — and pointer + error encodes
// that without an extra "found" boolean.
func ReadPending(path string) (*Pending, error) {
	bytes, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("read pending: %w", err)
	}
	var p Pending
	if err := json.Unmarshal(bytes, &p); err != nil {
		return nil, fmt.Errorf("parse pending: %w", err)
	}
	return &p, nil
}

// RemovePending deletes the sentinel at path. Idempotent: a missing
// file is not an error.
//
// Idempotency matters because the host watcher and any future
// "manual apply" UI (trust-app dashboard) might both try to remove
// the sentinel after a successful apply. Whichever runs second
// would otherwise crash on os.ErrNotExist.
func RemovePending(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove pending: %w", err)
	}
	return nil
}
