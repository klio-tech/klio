package cloud

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
)

func TestProvisionCallsExpectedEndpoint(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/users/provision" {
			t.Errorf("wrong path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("wrong method: %s", r.Method)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["agent_kind"] != "klio-bridge" {
			t.Errorf("wrong agent_kind: %v", body["agent_kind"])
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"user_id":          uuid.New().String(),
			"agent_id":         uuid.New().String(),
			"api_key":          "rt_" + strings.Repeat("x", 40),
			"claimed":          false,
			"default_space_id": uuid.New().String(),
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	resp, err := c.Provision(context.Background(), ProvisionRequest{
		AgentKind: "klio-bridge", InstallID: uuid.New(),
	})
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if resp.APIKey == "" {
		t.Fatal("APIKey empty")
	}
}

func TestRefreshAccessTokenRetriesOn401(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/spaces" && r.Header.Get("Authorization") != "Bearer fresh-access" {
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/v1/tokens/refresh" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "fresh-access", "refresh_token": "new-refresh", "expires_in": 3600,
			})
			return
		}
		w.WriteHeader(200)
		_ = json.NewEncoder(w).Encode([]any{})
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.SetRefreshToken("old-refresh")
	c.SetAccessToken("expired-access")

	if _, err := c.ListSpaces(context.Background()); err != nil {
		t.Fatalf("ListSpaces should retry on 401: %v", err)
	}
	if c.AccessToken() != "fresh-access" {
		t.Fatalf("access token not refreshed: %s", c.AccessToken())
	}
}

func TestNoRefreshTokenFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.SetAccessToken("expired")
	_, err := c.ListSpaces(context.Background())
	if err == nil {
		t.Fatal("expected error when no refresh token")
	}
}

// TestEnsureProjectPostsToEngine verifies the cloud client forwards
// (git_remote, repo_root_path, display_name) verbatim to the engine's
// /v1/projects/ensure endpoint and parses the returned project id.
//
// E1 surface-area test. E2 will exercise this method from inside the
// hook handler; for now we just prove the wire format matches the
// engine's EnsureRequest schema.
func TestEnsureProjectPostsToEngine(t *testing.T) {
	var got struct {
		GitRemote    string `json:"git_remote"`
		RepoRootPath string `json:"repo_root_path"`
		DisplayName  string `json:"display_name"`
	}
	var sawAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/projects/ensure" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("unexpected method: %s", r.Method)
		}
		sawAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"11111111-2222-3333-4444-555555555555"}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.SetAccessToken("test-token")
	id, err := c.EnsureProject(
		context.Background(),
		"git@github.com:klio-tech/klio.git",
		"/Users/x/klio",
		"klio-tech/klio",
	)
	if err != nil {
		t.Fatalf("EnsureProject: %v", err)
	}
	if id == uuid.Nil {
		t.Fatal("zero uuid returned")
	}
	want := uuid.MustParse("11111111-2222-3333-4444-555555555555")
	if id != want {
		t.Errorf("id = %s, want %s", id, want)
	}
	if got.GitRemote != "git@github.com:klio-tech/klio.git" {
		t.Errorf("git_remote = %q", got.GitRemote)
	}
	if got.RepoRootPath != "/Users/x/klio" {
		t.Errorf("repo_root_path = %q", got.RepoRootPath)
	}
	if got.DisplayName != "klio-tech/klio" {
		t.Errorf("display_name = %q", got.DisplayName)
	}
	if sawAuth != "Bearer test-token" {
		t.Errorf("Authorization header = %q", sawAuth)
	}
}

// TestEnsureProjectOmitsEmptyOptionalFields ensures the JSON wire
// format omits git_remote / repo_root_path when the caller passes an
// empty string — the engine's EnsureRequest rejects empty strings with
// min_length=1 (mirrors the C1 ingest schema), so sending `""` would
// 422 even though the bridge's intent is "this identifier is absent".
//
// `omitempty` on the request struct is load-bearing for this contract.
func TestEnsureProjectOmitsEmptyOptionalFields(t *testing.T) {
	var raw map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&raw)
		_, _ = w.Write([]byte(`{"id":"11111111-2222-3333-4444-555555555555"}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.SetAccessToken("test-token")
	if _, err := c.EnsureProject(
		context.Background(),
		"",
		"/Users/x/klio",
		"klio-detached",
	); err != nil {
		t.Fatalf("EnsureProject: %v", err)
	}
	if _, present := raw["git_remote"]; present {
		t.Errorf("git_remote should be omitted when empty, got: %v", raw)
	}
	if raw["repo_root_path"] != "/Users/x/klio" {
		t.Errorf("repo_root_path = %v", raw["repo_root_path"])
	}
	if raw["display_name"] != "klio-detached" {
		t.Errorf("display_name = %v", raw["display_name"])
	}
}

// TestEnsureProjectRefreshesOn401 verifies a stale access token on the
// EnsureProject hot path is silently refreshed and the original request
// retried. The bridge fires this method once per hook event (≈200 per
// Claude Code session); without refresh-on-401 coverage here, a token
// expiring on the wrong call would silently lose the project_id
// assignment and split that session's memory across multiple project
// rows (or worse, write entries with project_id=NULL).
//
// `TestRefreshAccessTokenRetriesOn401` already covers the generic
// refresh path via ListSpaces; this test asserts the same guarantee on
// the specific method that runs in the hottest loop, so a future change
// to EnsureProject (e.g. adding a custom transport or bypassing
// `c.do`) can't silently regress the contract.
func TestEnsureProjectRefreshesOn401(t *testing.T) {
	var ensureCalls int32
	var refreshCalls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/projects/ensure":
			n := atomic.AddInt32(&ensureCalls, 1)
			if n == 1 {
				// First attempt: stale access token, 401. Mirrors the
				// engine's behaviour when a JWT has expired mid-session.
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			// Second attempt (post-refresh): require the new bearer.
			if r.Header.Get("Authorization") != "Bearer fresh-access" {
				t.Errorf("retry sent stale bearer: %q", r.Header.Get("Authorization"))
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"11111111-2222-3333-4444-555555555555"}`))
		case "/v1/tokens/refresh":
			atomic.AddInt32(&refreshCalls, 1)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "fresh-access",
				"refresh_token": "new-refresh",
				"expires_in":    3600,
			})
		default:
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.SetAccessToken("stale-access")
	c.SetRefreshToken("old-refresh")

	id, err := c.EnsureProject(
		context.Background(),
		"git@github.com:klio-tech/klio.git",
		"/Users/x/klio",
		"klio-tech/klio",
	)
	if err != nil {
		t.Fatalf("EnsureProject: %v", err)
	}
	if id == uuid.Nil {
		t.Error("zero uuid returned")
	}
	want := uuid.MustParse("11111111-2222-3333-4444-555555555555")
	if id != want {
		t.Errorf("id = %s, want %s", id, want)
	}
	if got := atomic.LoadInt32(&ensureCalls); got != 2 {
		t.Errorf("expected 2 ensure calls (401 then 200); got %d", got)
	}
	if got := atomic.LoadInt32(&refreshCalls); got != 1 {
		t.Errorf("expected 1 refresh call; got %d", got)
	}
	if c.AccessToken() != "fresh-access" {
		t.Errorf("access token not rotated after refresh: %s", c.AccessToken())
	}
}

// TestPromoteProjectPostsToEngine verifies the cloud client forwards
// (project_id in path, space_id in body) to /v1/projects/{id}/promote
// and parses the echoed (project_id, dedicated_space_id) response.
//
// F2 surface-area test: proves the wire format matches the engine
// handler's PromoteRequest / PromoteResponse pydantic schemas.
func TestPromoteProjectPostsToEngine(t *testing.T) {
	var body map[string]any
	var sawAuth string
	var sawPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		sawPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(
			`{"project_id":"11111111-2222-3333-4444-555555555555",` +
				`"dedicated_space_id":"99999999-8888-7777-6666-555555555555"}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.SetAccessToken("test-token")
	resp, err := c.PromoteProject(
		context.Background(),
		"11111111-2222-3333-4444-555555555555",
		"99999999-8888-7777-6666-555555555555",
		"",
	)
	if err != nil {
		t.Fatalf("PromoteProject: %v", err)
	}
	if sawPath != "/v1/projects/11111111-2222-3333-4444-555555555555/promote" {
		t.Errorf("wrong path: %s", sawPath)
	}
	if sawAuth != "Bearer test-token" {
		t.Errorf("Authorization header = %q", sawAuth)
	}
	if body["space_id"] != "99999999-8888-7777-6666-555555555555" {
		t.Errorf("space_id = %v", body["space_id"])
	}
	if _, present := body["embedding_model"]; present {
		t.Errorf("embedding_model should be omitted, body: %v", body)
	}
	if resp.ProjectID != uuid.MustParse("11111111-2222-3333-4444-555555555555") {
		t.Errorf("ProjectID = %s", resp.ProjectID)
	}
	if resp.DedicatedSpaceID != uuid.MustParse("99999999-8888-7777-6666-555555555555") {
		t.Errorf("DedicatedSpaceID = %s", resp.DedicatedSpaceID)
	}
}

// TestPromoteProjectOmitsEmptyOptionalFields ensures the JSON wire
// format omits whichever of space_id / embedding_model is empty.
// The engine's PromoteRequest XOR-validates non-null fields, so a
// stray empty string would shift behaviour from "absent" to "supplied
// and 422" — symmetric to the EnsureProject omitempty contract.
func TestPromoteProjectOmitsEmptyOptionalFields(t *testing.T) {
	var raw map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&raw)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(
			`{"project_id":"11111111-2222-3333-4444-555555555555",` +
				`"dedicated_space_id":"99999999-8888-7777-6666-555555555555"}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.SetAccessToken("test-token")
	if _, err := c.PromoteProject(
		context.Background(),
		"11111111-2222-3333-4444-555555555555",
		"",
		"ollama/snowflake-arctic-embed2",
	); err != nil {
		t.Fatalf("PromoteProject: %v", err)
	}
	if _, present := raw["space_id"]; present {
		t.Errorf("space_id should be omitted when empty, got: %v", raw)
	}
	if raw["embedding_model"] != "ollama/snowflake-arctic-embed2" {
		t.Errorf("embedding_model = %v", raw["embedding_model"])
	}
}

// TestRecallSendsProjectField verifies the optional `project` field on
// RecallRequest is forwarded to the engine. E3 will populate this from
// the MCP recall tool's resolved project key; E1 just gets the field
// onto the wire so E3 doesn't have to touch types.go again.
func TestRecallSendsProjectField(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.SetAccessToken("test-token")
	spaceID := uuid.New()
	if _, err := c.Recall(context.Background(), spaceID, RecallRequest{
		Query:   "anything",
		Project: "git@github.com:klio-tech/klio.git",
	}); err != nil {
		t.Fatalf("Recall: %v", err)
	}
	if body["project"] != "git@github.com:klio-tech/klio.git" {
		t.Errorf("project field missing or wrong: %v", body["project"])
	}
}

// TestRecallOmitsEmptyProjectField verifies an unset Project (zero
// string) does NOT serialize on the wire — the engine treats a missing
// `project` key as "no filter" (B3 semantics), so sending `""` would
// shift behaviour from `any` to `exact-empty-string-match` and produce
// zero results.
func TestRecallOmitsEmptyProjectField(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.SetAccessToken("test-token")
	if _, err := c.Recall(context.Background(), uuid.New(), RecallRequest{
		Query: "anything",
	}); err != nil {
		t.Fatalf("Recall: %v", err)
	}
	if _, present := body["project"]; present {
		t.Errorf("project should be omitted when empty, got: %v", body)
	}
}
