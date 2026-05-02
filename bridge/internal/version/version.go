// Package version exposes the build version of klio-bridge.
package version

const v = "0.0.1"

// Get returns the current Klio bridge version.
func Get() string {
	return v
}
