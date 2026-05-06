// Package updater drives the bridge's auto-update lifecycle:
// version checks against the npm registry, docker-compose
// pull/recreate, and per-update bookkeeping in
// ~/.klio/update-state.json (mounted at /host/.klio in production).
//
// This file (state.go) is the persistence layer. The state file is
// the single source of truth for "what version are we on" and
// "what version did we last apply" — engine + trust-app read it
// for status surfaces, the updater ticker writes it after every
// check or apply.
package updater

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// State is the on-disk shape of update-state.json.
//
// Field names use snake_case JSON tags to match the design doc.
// Time fields use RFC3339 (Go's time.Time MarshalJSON default).
// Missing/empty time fields serialize as the zero value but are
// distinguishable from "set to epoch" via the omitempty rule —
// callers that care use IsZero() rather than comparing strings.
type State struct {
	// CurrentVersion is the version this bridge is running. Set at
	// startup from KLIO_BRIDGE_VERSION env (image-baked).
	CurrentVersion string `json:"current_version"`

	// LastCheckAt is the wall-clock of the most recent registry
	// check, regardless of outcome.
	LastCheckAt time.Time `json:"last_check_at,omitempty"`

	// LastCheckError is non-empty iff the most recent check failed
	// (network, parse, etc.). Cleared on a successful check.
	LastCheckError string `json:"last_check_error,omitempty"`

	// LastKnownAvailableVersion is the most recent newer-than-
	// current version observed via successful registry check.
	// Empty if no newer version has been observed.
	LastKnownAvailableVersion string `json:"last_known_available_version,omitempty"`

	// LastAppliedVersion is the version most recently pulled +
	// recreated by the updater (apply mode). May lag CurrentVersion
	// by one tick if the bridge container has restarted onto the
	// new image but hasn't ticked yet.
	LastAppliedVersion string `json:"last_applied_version,omitempty"`

	// LastAppliedAt is the wall-clock of the most recent successful
	// apply. Zero value when no apply has occurred yet on this host.
	LastAppliedAt time.Time `json:"last_applied_at,omitempty"`

	// LastApplyError is non-empty iff the most recent apply failed
	// (compose pull rate-limit, recreate failure, etc.). Cleared on
	// a successful apply.
	LastApplyError string `json:"last_apply_error,omitempty"`
}

// Read returns the state stored at path, or a zero-value State
// (with CurrentVersion left blank — callers fill it in) if the
// file is missing. Other errors (corrupt JSON, permission) are
// surfaced verbatim.
func Read(path string) (State, error) {
	bytes, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return State{}, nil
		}
		return State{}, fmt.Errorf("read update-state: %w", err)
	}
	var s State
	if err := json.Unmarshal(bytes, &s); err != nil {
		return State{}, fmt.Errorf("parse update-state: %w", err)
	}
	return s, nil
}

// Write atomically writes state to path with mode 0644.
//
// Atomicity: write to a temp file in the same directory, then
// rename. This prevents readers from observing a partially-written
// file even if the process is killed mid-write.
//
// The parent directory must exist (caller is expected to have
// volume-mounted ~/.klio); creating it here would mask a
// misconfigured mount.
func Write(path string, s State) error {
	bytes, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal update-state: %w", err)
	}
	bytes = append(bytes, '\n')
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".update-state.*.tmp")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	tmpPath := tmp.Name()
	// Best-effort cleanup if anything below fails before the rename.
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
