// Package version is the single source of truth for the bridge's
// build version.
//
// The resolution order is:
//
//  1. /etc/klio-version (image-baked, written by the Dockerfile from
//     the --build-arg KLIO_VERSION). The production path: the file
//     ships in the same image layer as the binary, so the version
//     reported by the bridge is guaranteed to match what's running.
//     Cannot be accidentally cleared by `unset KLIO_BRIDGE_VERSION`
//     in a parent shell.
//  2. KLIO_BRIDGE_VERSION env var. The dev path: a developer running
//     `go run ./cmd/klio version` outside the container has no
//     `/etc/klio-version` and may have the env set in their shell
//     profile.
//  3. The literal string `0.0.0-dev`. The panic-button: nothing
//     plausible to surface. The npm CLI's update-state UI keys off
//     this exact value to render a "you're on a dev build" banner.
//
// Why the file is a layer above env (and not the other way around):
// the production failure mode we're guarding against is "image was
// built correctly, but compose template forgot to thread
// KLIO_BRIDGE_VERSION through to the running container, so the
// bridge reports 0.0.0-dev despite running 0.6.0". Putting the file
// first means even a misconfigured compose template can't make the
// bridge lie about its own version.
package version

import (
	"os"
	"strings"
)

// versionFilePath is the production path the Dockerfile writes the
// build-time KLIO_VERSION arg to. Tests use the package-private
// getFromPath function to drive a tempfile path; production code
// (Get()) reads only this constant.
const versionFilePath = "/etc/klio-version"

// envVarName is the env-var name the bridge reads when the file is
// absent or empty. Kept as a constant rather than inlined so a future
// rename (e.g. to KLIO_VERSION for parity with the Dockerfile arg
// name) is a one-line change.
const envVarName = "KLIO_BRIDGE_VERSION"

// fallbackVersion is the value returned when neither the file nor
// the env are set. Intentionally NOT a real semver — `0.0.0-dev`
// trips dashboards' dev-build banner, which is the right UX
// signal when a developer runs the bridge outside the image.
const fallbackVersion = "0.0.0-dev"

// Get returns the build version of klio-bridge per the resolution
// order documented at the package level.
func Get() string {
	return getFromPath(versionFilePath)
}

// getFromPath is Get() with the file path injected, exposed at
// package scope so tests can drive a tempfile path. Tests that want
// to exercise the env-fallback branch use a non-existent path and
// `t.Setenv(envVarName, ...)`.
func getFromPath(path string) string {
	if v := readVersionFile(path); v != "" {
		return v
	}
	if v := strings.TrimSpace(os.Getenv(envVarName)); v != "" {
		return v
	}
	return fallbackVersion
}

// readVersionFile returns the trimmed content of path, or the empty
// string if the file is missing, unreadable, or empty after
// trimming. An empty file is treated identically to a missing file
// so callers fall through to the env-var branch — surfacing "" as a
// valid version would break JSON consumers downstream.
//
// Errors other than os.ErrNotExist (e.g. permission denied) are
// silently swallowed because the bridge daemon must keep running
// even if /etc has unusual perms; the env-var fallback exists
// precisely for these edge cases.
func readVersionFile(path string) string {
	bytes, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(bytes))
}
