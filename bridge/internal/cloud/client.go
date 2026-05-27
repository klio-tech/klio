// Package cloud is the daemon's HTTP client for api.klio.tech.
//
// Manages access-token + refresh-token lifecycle. Auto-retries once on 401
// after refreshing. All calls go through a single transport with sane
// timeouts and a small connection pool.
package cloud

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

var (
	// ErrUnauthorized is returned when the cloud responds 401 even after refresh.
	ErrUnauthorized = errors.New("cloud: unauthorized")
	// ErrNoCredentials means we have no access or refresh token to use.
	ErrNoCredentials = errors.New("cloud: no credentials")
)

// Client is the bridge daemon's HTTPS client for api.klio.tech.
type Client struct {
	baseURL      string
	http         *http.Client
	mu           sync.RWMutex
	accessToken  string
	refreshToken string
}

// NewClient returns a Client for baseURL with no TLS cert pinning.
// Use NewClientWithPinning for production deployments against api.klio.tech.
func NewClient(baseURL string) *Client {
	return NewClientWithPinning(baseURL, "")
}

// NewClientWithPinning returns a Client that requires the leaf TLS cert's
// SHA-256 fingerprint to equal `pinnedCertSHA256` (hex, optional colons).
// Empty string disables pinning. Pinning is *additive* to standard CA chain
// verification, never a replacement.
func NewClientWithPinning(baseURL, pinnedCertSHA256 string) *Client {
	transport := &http.Transport{
		MaxIdleConns:        10,
		MaxIdleConnsPerHost: 5,
		IdleConnTimeout:     90 * time.Second,
	}
	if v := pinnedTLSVerify(pinnedCertSHA256); v != nil {
		transport.TLSClientConfig = &tls.Config{
			MinVersion:       tls.VersionTLS12,
			VerifyConnection: v,
		}
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		http: &http.Client{
			Timeout:   30 * time.Second,
			Transport: transport,
		},
	}
}

// SetAccessToken / SetRefreshToken / AccessToken / RefreshToken: thread-safe accessors.
func (c *Client) SetAccessToken(t string)  { c.mu.Lock(); c.accessToken = t; c.mu.Unlock() }
func (c *Client) SetRefreshToken(t string) { c.mu.Lock(); c.refreshToken = t; c.mu.Unlock() }
func (c *Client) AccessToken() string      { c.mu.RLock(); defer c.mu.RUnlock(); return c.accessToken }
func (c *Client) RefreshToken() string     { c.mu.RLock(); defer c.mu.RUnlock(); return c.refreshToken }

// BaseURL returns the configured cloud base URL (used by realtime client to derive ws://).
func (c *Client) BaseURL() string { return c.baseURL }

// Provision calls POST /v1/users/provision. Does not require auth.
func (c *Client) Provision(ctx context.Context, req ProvisionRequest) (*ProvisionResponse, error) {
	var resp ProvisionResponse
	if err := c.do(ctx, "POST", "/v1/users/provision", req, &resp, false); err != nil {
		return nil, err
	}
	return &resp, nil
}

// Refresh rotates the refresh token and stores new access/refresh tokens on the client.
func (c *Client) Refresh(ctx context.Context) error {
	rt := c.RefreshToken()
	if rt == "" {
		return ErrNoCredentials
	}
	body := map[string]string{"refresh_token": rt}
	var resp RefreshResponse
	if err := c.do(ctx, "POST", "/v1/tokens/refresh", body, &resp, false); err != nil {
		return err
	}
	c.SetAccessToken(resp.AccessToken)
	c.SetRefreshToken(resp.RefreshToken)
	return nil
}

// ListSpaces returns the authenticated user's spaces.
func (c *Client) ListSpaces(ctx context.Context) ([]Space, error) {
	var spaces []Space
	if err := c.do(ctx, "GET", "/v1/spaces", nil, &spaces, true); err != nil {
		return nil, err
	}
	return spaces, nil
}

// Recall calls POST /v1/spaces/{id}/recall.
func (c *Client) Recall(ctx context.Context, spaceID uuid.UUID, req RecallRequest) ([]Entry, error) {
	var entries []Entry
	path := fmt.Sprintf("/v1/spaces/%s/recall", spaceID)
	if err := c.do(ctx, "POST", path, req, &entries, true); err != nil {
		return nil, err
	}
	return entries, nil
}

// WriteEntry calls POST /v1/spaces/{id}/entries.
func (c *Client) WriteEntry(ctx context.Context, spaceID uuid.UUID, req EntryWrite) (*Entry, error) {
	var e Entry
	path := fmt.Sprintf("/v1/spaces/%s/entries", spaceID)
	if err := c.do(ctx, "POST", path, req, &e, true); err != nil {
		return nil, err
	}
	return &e, nil
}

// EnsureProject calls POST /v1/projects/ensure and returns the
// resulting project_id. The engine handles get-or-create semantics
// (deduplicates by git_remote when present, else by repo_root_path).
//
// At least one of gitRemote or repoRootPath must be non-empty; the
// engine 422s otherwise. The bridge's project.Resolve guarantees this
// for AbsCwd-anchored Keys (DisplayName is always set).
//
// E1 surface-area only: nothing in the bridge calls this yet. E2 will
// wire the hook handler to invoke EnsureProject before tagging writes
// with the returned project_id.
func (c *Client) EnsureProject(
	ctx context.Context, gitRemote, repoRootPath, displayName string,
) (uuid.UUID, error) {
	body := ensureProjectRequest{
		GitRemote:    gitRemote,
		RepoRootPath: repoRootPath,
		DisplayName:  displayName,
	}
	var resp ensureProjectResponse
	if err := c.do(ctx, "POST", "/v1/projects/ensure", body, &resp, true); err != nil {
		return uuid.Nil, err
	}
	return resp.ID, nil
}

// PromoteProject calls POST /v1/projects/{project_id}/promote (F1).
//
// Exactly one of spaceID / embeddingModel must be non-empty — the
// engine's PromoteRequest schema XOR-validates and 422s otherwise.
// Callers (the `klio project promote` CLI) enforce this client-side
// before invoking; this method intentionally does NOT pre-check so a
// future caller hitting the engine path directly gets the same error
// shape any other HTTP client would.
//
// spaceID is forwarded as a string rather than uuid.UUID because the
// CLI receives it as a `--space=<uuid>` flag and the engine accepts
// the canonical 36-char dashed form. Conversion would round-trip
// through uuid.Parse + UUID.String() with no gain.
//
// Returns the project_id (echoed) and the newly-pinned
// dedicated_space_id. The 30s client timeout applies; promotion is
// fast (one INSERT + one UPDATE inside a transaction) so a deadline
// extension isn't warranted here.
func (c *Client) PromoteProject(
	ctx context.Context, projectID, spaceID, embeddingModel string,
) (*PromoteResponse, error) {
	body := PromoteRequest{
		SpaceID:        spaceID,
		EmbeddingModel: embeddingModel,
	}
	var resp PromoteResponse
	path := fmt.Sprintf("/v1/projects/%s/promote", projectID)
	if err := c.do(ctx, "POST", path, body, &resp, true); err != nil {
		return nil, err
	}
	return &resp, nil
}

// IngestTranscript calls POST /v1/spaces/{id}/ingest/transcript.
func (c *Client) IngestTranscript(
	ctx context.Context,
	spaceID uuid.UUID,
	body map[string]any,
) (map[string]any, error) {
	var resp map[string]any
	path := fmt.Sprintf("/v1/spaces/%s/ingest/transcript", spaceID)
	if err := c.do(ctx, "POST", path, body, &resp, true); err != nil {
		return nil, err
	}
	return resp, nil
}

// ReembedSpace calls POST /v1/spaces/{space_id}/reembed.
//
// Re-embeds every entry in the space under the supplied target model.
// Blocks until the engine returns; for large spaces, the call may take
// minutes. Caller should display the returned counts on success.
func (c *Client) ReembedSpace(
	ctx context.Context, spaceID uuid.UUID, toModel string,
) (*ReembedResponse, error) {
	body := map[string]any{"to_model": toModel}
	var resp ReembedResponse
	path := fmt.Sprintf("/v1/spaces/%s/reembed", spaceID)
	if err := c.do(ctx, "POST", path, body, &resp, true); err != nil {
		return nil, err
	}
	return &resp, nil
}

// RequestAccess calls POST /v1/agents/{agent_id}/request-access.
//
// agentID is typically the daemon's own agent_id (the one minted at
// klio init); the engine will reject any mismatch with the token's
// agent claim.
func (c *Client) RequestAccess(
	ctx context.Context, agentID uuid.UUID, spaceSlug, scope, reason string,
) (map[string]any, error) {
	body := map[string]any{
		"space_slug":      spaceSlug,
		"requested_scope": scope,
	}
	if reason != "" {
		body["reason"] = reason
	}
	var resp map[string]any
	path := fmt.Sprintf("/v1/agents/%s/request-access", agentID)
	if err := c.do(ctx, "POST", path, body, &resp, true); err != nil {
		return nil, err
	}
	return resp, nil
}

// do executes a request, optionally retrying once on 401 after a token refresh.
func (c *Client) do(
	ctx context.Context, method, path string, body any, out any, withAuth bool,
) error {
	for attempt := 0; attempt < 2; attempt++ {
		err := c.doOnce(ctx, method, path, body, out, withAuth)
		if err == nil {
			return nil
		}
		if !errors.Is(err, ErrUnauthorized) || !withAuth || attempt == 1 {
			return err
		}
		if rerr := c.Refresh(ctx); rerr != nil {
			return fmt.Errorf("refresh failed: %w (original: %v)", rerr, err)
		}
	}
	return ErrUnauthorized
}

func (c *Client) doOnce(
	ctx context.Context, method, path string, body any, out any, withAuth bool,
) error {
	u, err := url.JoinPath(c.baseURL, path)
	if err != nil {
		return err
	}
	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if withAuth {
		req.Header.Set("Authorization", "Bearer "+c.AccessToken())
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return ErrUnauthorized
	}
	if resp.StatusCode >= 400 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("cloud: %d %s: %s", resp.StatusCode, resp.Status, bodyBytes)
	}
	if out != nil && resp.StatusCode != http.StatusNoContent {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}
