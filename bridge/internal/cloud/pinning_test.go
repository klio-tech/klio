package cloud

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestPinnedClientAcceptsMatchingCert spins up an httptest TLS server, captures
// its cert's SHA-256 fingerprint, builds a Client pinned to that fingerprint,
// and verifies a request succeeds.
func TestPinnedClientAcceptsMatchingCert(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]map[string]any{})
	}))
	defer srv.Close()

	leafFP := certFingerprint(srv)
	c := NewClientWithPinning(srv.URL, leafFP)

	// Need to trust the test CA (httptest.TLSServer self-signs). Inject the
	// test cert into the transport's RootCAs.
	addRootCA(t, c, srv)

	// Should succeed.
	if _, err := c.ListSpaces(context.Background()); err != nil {
		t.Fatalf("ListSpaces (matching pin): %v", err)
	}
}

// TestPinnedClientRejectsMismatchedCert captures a real fingerprint, then
// twiddles one byte to fabricate a wrong pin, and verifies the request fails.
func TestPinnedClientRejectsMismatchedCert(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()

	wrongFP := strings.Repeat("aa", 32) // not the server's actual cert
	c := NewClientWithPinning(srv.URL, wrongFP)
	addRootCA(t, c, srv)

	_, err := c.ListSpaces(context.Background())
	if err == nil {
		t.Fatal("expected error from cert pin mismatch")
	}
	if !strings.Contains(err.Error(), "mismatch") && !strings.Contains(err.Error(), "pinned") {
		t.Fatalf("expected pin-mismatch-style error, got: %v", err)
	}
}

// TestEmptyPinDoesNotEnforce: when the pinned fingerprint is empty, the
// client should connect normally (just standard CA validation).
func TestEmptyPinDoesNotEnforce(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]map[string]any{})
	}))
	defer srv.Close()

	c := NewClientWithPinning(srv.URL, "") // pinning OFF
	addRootCA(t, c, srv)

	if _, err := c.ListSpaces(context.Background()); err != nil {
		t.Fatalf("ListSpaces (no pin): %v", err)
	}
}

// TestNormalizeFingerprint accepts uppercase, colons, and spaces.
func TestNormalizeFingerprint(t *testing.T) {
	cases := map[string]string{
		"ABCD":                              "abcd",
		"AB:CD:EF":                          "abcdef",
		"ab:cd ef":                          "abcdef",
		"":                                  "",
		"deadBEEFcafe":                      "deadbeefcafe",
	}
	for in, want := range cases {
		if got := normalizeFingerprint(in); got != want {
			t.Errorf("normalizeFingerprint(%q) = %q, want %q", in, got, want)
		}
	}
}

// --- helpers ---

func certFingerprint(srv *httptest.Server) string {
	// The httptest.Server's leaf cert is exposed via Certificate().
	cert := srv.Certificate()
	sum := sha256.Sum256(cert.Raw)
	return hex.EncodeToString(sum[:])
}

func addRootCA(t *testing.T, c *Client, srv *httptest.Server) {
	t.Helper()
	transport, ok := c.http.Transport.(*http.Transport)
	if !ok {
		t.Fatal("transport is not *http.Transport")
	}
	if transport.TLSClientConfig == nil {
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	transport.TLSClientConfig.RootCAs = srv.Client().Transport.(*http.Transport).TLSClientConfig.RootCAs
}
