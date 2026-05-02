package cloud

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"strings"
)

// errPinMismatch is the verification error surfaced by the pinned dialer.
var errPinMismatch = errors.New("cloud: pinned cert SHA-256 mismatch")

// pinnedTLSVerify returns a TLS VerifyConnection callback that requires
// the leaf certificate's SHA-256 fingerprint to match `wantHex` (lowercase
// hex with optional colons stripped). Returns nil if wantHex is empty
// (i.e., pinning disabled).
//
// We use VerifyConnection (post-handshake) so the standard chain validation
// still runs; pinning is *additive* to CA verification, not a replacement.
func pinnedTLSVerify(wantHex string) func(tls.ConnectionState) error {
	want := normalizeFingerprint(wantHex)
	if want == "" {
		return nil
	}
	return func(cs tls.ConnectionState) error {
		if len(cs.PeerCertificates) == 0 {
			return errPinMismatch
		}
		// PeerCertificates[0] is the leaf.
		leaf := cs.PeerCertificates[0]
		got := fingerprint(leaf)
		if got != want {
			return errPinMismatch
		}
		return nil
	}
}

func fingerprint(cert *x509.Certificate) string {
	sum := sha256.Sum256(cert.Raw)
	return hex.EncodeToString(sum[:])
}

func normalizeFingerprint(s string) string {
	s = strings.ToLower(s)
	s = strings.ReplaceAll(s, ":", "")
	s = strings.ReplaceAll(s, " ", "")
	return s
}
