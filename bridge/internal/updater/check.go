package updater

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// NpmRegistryURL is the canonical "latest published version of
// @klio-tech/klio" endpoint. Returns a JSON document with at
// least a `version` field.
const NpmRegistryURL = "https://registry.npmjs.org/@klio-tech/klio/latest"

// HTTPGetter is the minimal subset of *http.Client used by Check.
// Tests stub this with an in-memory client to avoid hitting the
// real registry.
type HTTPGetter interface {
	Do(req *http.Request) (*http.Response, error)
}

// DefaultClient returns the production HTTP client used by the
// updater ticker — short timeout, no redirects beyond the default
// 10-hop limit.
func DefaultClient() *http.Client {
	return &http.Client{Timeout: 10 * time.Second}
}

// Check fetches the latest published version of @klio-tech/klio
// from the npm registry and returns its `version` string.
//
// Errors are wrapped with context for the daemon log; callers are
// expected to write them to State.LastCheckError verbatim.
func Check(ctx context.Context, client HTTPGetter) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, NpmRegistryURL, nil)
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", "klio-bridge")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("npm registry request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("npm registry returned HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read response: %w", err)
	}
	var out struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("parse response: %w", err)
	}
	if out.Version == "" {
		return "", fmt.Errorf("registry response missing version field")
	}
	return out.Version, nil
}

// IsNewer reports whether `latest` is strictly greater than
// `current` per semver MAJOR.MINOR.PATCH. Pre-release suffixes
// (e.g., "0.6.0-rc.1") are ignored — only the numeric triple is
// compared. Treats invalid input (anything non-semver) as
// "false" — never auto-applies on bogus version strings.
//
// This is a deliberately tiny semver implementation. The bridge
// has no external semver dependency, and the only cases we care
// about are clean numeric triples. Edge cases (build metadata,
// pre-release ordering rules) are out of scope; v0.6.0 doesn't
// publish pre-release tags to the npm `latest` channel.
func IsNewer(current, latest string) bool {
	cur, ok := parseSemver(current)
	if !ok {
		return false
	}
	lat, ok := parseSemver(latest)
	if !ok {
		return false
	}
	if lat[0] != cur[0] {
		return lat[0] > cur[0]
	}
	if lat[1] != cur[1] {
		return lat[1] > cur[1]
	}
	return lat[2] > cur[2]
}

// parseSemver returns the [major, minor, patch] triple for a
// version string, or (zero, false) if the string isn't a clean
// numeric triple. Pre-release / build suffixes are stripped first.
func parseSemver(v string) ([3]int, bool) {
	var zero [3]int
	// Strip a leading "v" if present (registry never emits one
	// but defensive against config typos).
	v = strings.TrimPrefix(v, "v")
	// Strip pre-release / build suffix (everything after `-` or `+`).
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return zero, false
	}
	var out [3]int
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return zero, false
		}
		out[i] = n
	}
	return out, true
}
