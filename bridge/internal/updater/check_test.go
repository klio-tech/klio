package updater

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"testing"
)

// roundTripperFunc lets tests inject a closure as an http.RoundTripper.
type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

// stubClient builds an *http.Client whose every request resolves
// via the provided closure. Use to inject canned registry responses.
func stubClient(fn roundTripperFunc) *http.Client {
	return &http.Client{Transport: fn}
}

func TestCheckHappyPath(t *testing.T) {
	client := stubClient(func(req *http.Request) (*http.Response, error) {
		if req.URL.String() != NpmRegistryURL {
			t.Fatalf("unexpected URL: %s", req.URL.String())
		}
		body := `{"name":"@klio-tech/klio","version":"0.6.1","other":"ignored"}`
		return &http.Response{
			StatusCode: 200,
			Body:       io.NopCloser(bytes.NewBufferString(body)),
			Header:     make(http.Header),
		}, nil
	})
	v, err := Check(context.Background(), client)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if v != "0.6.1" {
		t.Errorf("got %q want 0.6.1", v)
	}
}

func TestCheckHTTPNon200(t *testing.T) {
	client := stubClient(func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: 503,
			Body:       io.NopCloser(bytes.NewBufferString("")),
			Header:     make(http.Header),
		}, nil
	})
	_, err := Check(context.Background(), client)
	if err == nil {
		t.Fatal("expected error for HTTP 503, got nil")
	}
}

func TestCheckMalformedJSON(t *testing.T) {
	client := stubClient(func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: 200,
			Body:       io.NopCloser(bytes.NewBufferString("not json")),
			Header:     make(http.Header),
		}, nil
	})
	_, err := Check(context.Background(), client)
	if err == nil {
		t.Fatal("expected error for malformed JSON, got nil")
	}
}

func TestCheckMissingVersionField(t *testing.T) {
	client := stubClient(func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: 200,
			Body:       io.NopCloser(bytes.NewBufferString(`{"name":"x"}`)),
			Header:     make(http.Header),
		}, nil
	})
	_, err := Check(context.Background(), client)
	if err == nil {
		t.Fatal("expected error for missing version, got nil")
	}
}

func TestCheckTransportError(t *testing.T) {
	client := stubClient(func(req *http.Request) (*http.Response, error) {
		return nil, errors.New("simulated network failure")
	})
	_, err := Check(context.Background(), client)
	if err == nil {
		t.Fatal("expected error for transport failure, got nil")
	}
}

func TestIsNewer(t *testing.T) {
	cases := []struct {
		current, latest string
		want            bool
	}{
		{"0.5.4", "0.5.5", true},   // patch bump
		{"0.5.4", "0.6.0", true},   // minor bump
		{"0.5.4", "1.0.0", true},   // major bump
		{"0.5.4", "0.5.4", false},  // equal
		{"0.5.4", "0.5.3", false},  // older
		{"0.5.4", "0.4.10", false}, // older minor
		{"v0.5.4", "0.5.5", true},  // leading-v current
		{"0.5.4", "v0.5.5", true},  // leading-v latest
		{"0.5.4", "0.5.5-rc.1", true},  // pre-release suffix stripped
		{"0.5.4-rc.1", "0.5.4", false}, // pre-release == release per our compare
		{"not-semver", "0.6.0", false}, // invalid current
		{"0.5.4", "not-semver", false}, // invalid latest
		{"0.5", "0.6.0", false},        // too few parts
		{"0.5.4.0", "0.6.0.0", false},  // too many parts
	}
	for _, c := range cases {
		got := IsNewer(c.current, c.latest)
		if got != c.want {
			t.Errorf("IsNewer(%q, %q): got %v want %v", c.current, c.latest, got, c.want)
		}
	}
}
