package mcp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

type stubBackend struct {
	recallCalled       bool
	recallProjectID    uuid.UUID
	writeCalled        bool
	writeKind          string
	writeProjectID     uuid.UUID
	listCalled         bool
	switchedTo         string
	requestedSlug      string
	requestedScope     string
	ensureCalled       bool
	ensureID           uuid.UUID
	ensureGitRemote    string
	ensureRepoRootPath string
	ensureDisplayName  string
}

func (s *stubBackend) Recall(
	_ context.Context, _, _, _ string, _ int, projectID uuid.UUID,
) ([]map[string]any, error) {
	s.recallCalled = true
	s.recallProjectID = projectID
	return []map[string]any{{"content": "fake result", "kind": "memory"}}, nil
}

func (s *stubBackend) WriteEntry(
	_ context.Context,
	kind, content, _ string,
	_ map[string]any,
	projectID uuid.UUID,
) (map[string]any, error) {
	s.writeCalled = true
	s.writeKind = kind
	s.writeProjectID = projectID
	return map[string]any{"id": uuid.New().String(), "kind": kind, "content": content}, nil
}

func (s *stubBackend) ListSpaces(_ context.Context) ([]map[string]any, error) {
	s.listCalled = true
	return []map[string]any{{"name": "Default", "slug": "default"}}, nil
}

func (s *stubBackend) SwitchSpace(_ context.Context, slug string) error {
	s.switchedTo = slug
	return nil
}

func (s *stubBackend) RequestAccess(_ context.Context, slug, scope string) error {
	s.requestedSlug = slug
	s.requestedScope = scope
	return nil
}

func (s *stubBackend) ActiveSpaceInfo(_ context.Context) (map[string]any, error) {
	return map[string]any{"name": "Default"}, nil
}

func (s *stubBackend) EnsureProject(
	_ context.Context, gitRemote, repoRootPath, displayName string,
) (uuid.UUID, error) {
	s.ensureCalled = true
	s.ensureGitRemote = gitRemote
	s.ensureRepoRootPath = repoRootPath
	s.ensureDisplayName = displayName
	if s.ensureID == uuid.Nil {
		s.ensureID = uuid.New()
	}
	return s.ensureID, nil
}

func TestInitializeReturnsServerInfo(t *testing.T) {
	d := NewDispatcher(&stubBackend{})
	resp := d.Handle([]byte(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`))
	var r Response
	_ = json.Unmarshal(resp, &r)
	if r.Error != nil {
		t.Fatalf("error: %v", r.Error)
	}
	res := r.Result.(map[string]any)
	if _, ok := res["protocolVersion"]; !ok {
		t.Fatal("missing protocolVersion")
	}
}

func TestToolsListReturnsSeven(t *testing.T) {
	d := NewDispatcher(&stubBackend{})
	resp := d.Handle([]byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	var r Response
	_ = json.Unmarshal(resp, &r)
	res := r.Result.(map[string]any)
	tools := res["tools"].([]any)
	if len(tools) != 7 {
		t.Fatalf("expected 7 tools, got %d", len(tools))
	}
}

func TestRecallToolCall(t *testing.T) {
	b := &stubBackend{}
	d := NewDispatcher(b)
	resp := d.Handle([]byte(
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"recall","arguments":{"query":"q"}}}`,
	))
	var r Response
	_ = json.Unmarshal(resp, &r)
	if r.Error != nil {
		t.Fatalf("error: %v", r.Error)
	}
	if !b.recallCalled {
		t.Fatal("backend.Recall not called")
	}
}

func TestRememberToolCall(t *testing.T) {
	b := &stubBackend{}
	d := NewDispatcher(b)
	resp := d.Handle([]byte(
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"remember","arguments":{"content":"User likes Go"}}}`,
	))
	var r Response
	_ = json.Unmarshal(resp, &r)
	if r.Error != nil {
		t.Fatalf("error: %v", r.Error)
	}
	if b.writeKind != "remember" {
		t.Fatalf("expected kind remember, got %s", b.writeKind)
	}
}

func TestSpaceSwitch(t *testing.T) {
	b := &stubBackend{}
	d := NewDispatcher(b)
	resp := d.Handle([]byte(
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"space","arguments":{"action":"switch","name":"klio"}}}`,
	))
	var r Response
	_ = json.Unmarshal(resp, &r)
	if r.Error != nil {
		t.Fatalf("error: %v", r.Error)
	}
	if b.switchedTo != "klio" {
		t.Fatalf("switch target = %s", b.switchedTo)
	}
}

func TestUnknownToolReturnsError(t *testing.T) {
	d := NewDispatcher(&stubBackend{})
	resp := d.Handle([]byte(
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nope","arguments":{}}}`,
	))
	var r Response
	_ = json.Unmarshal(resp, &r)
	if r.Error == nil {
		t.Fatal("expected error for unknown tool")
	}
}

func TestNotificationsInitializedReturnsNil(t *testing.T) {
	d := NewDispatcher(&stubBackend{})
	resp := d.Handle([]byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
	if resp != nil {
		t.Fatalf("expected nil response for notification, got %s", resp)
	}
}

// TestRecallForwardsProjectID covers the wire contract: when the hook
// runner sends `project_id` in the arguments map, the dispatcher MUST
// parse it as a UUID and forward to backend.Recall. Without this,
// per-project scoping silently degrades to cross-project recall.
func TestRecallForwardsProjectID(t *testing.T) {
	b := &stubBackend{}
	d := NewDispatcher(b)
	wanted := uuid.MustParse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{` +
		`"name":"recall","arguments":{"query":"q","project_id":"` + wanted.String() + `"}}}`
	resp := d.Handle([]byte(body))
	var r Response
	_ = json.Unmarshal(resp, &r)
	if r.Error != nil {
		t.Fatalf("error: %v", r.Error)
	}
	if b.recallProjectID != wanted {
		t.Errorf("expected backend.Recall to receive %v, got %v",
			wanted, b.recallProjectID)
	}
}

// TestRecallToleratesBadProjectID is the fail-open guarantee: an
// unparseable project_id from a buggy or stale hook client must not 400
// the call. The dispatcher silently falls back to uuid.Nil and lets the
// recall run (cross-project scope). Surfacing a hard error here would
// break the user's session-start context warmup on the rare day someone
// ships a client that mangles uuid strings.
func TestRecallToleratesBadProjectID(t *testing.T) {
	b := &stubBackend{}
	d := NewDispatcher(b)
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{` +
		`"name":"recall","arguments":{"query":"q","project_id":"not-a-uuid"}}}`
	resp := d.Handle([]byte(body))
	var r Response
	_ = json.Unmarshal(resp, &r)
	if r.Error != nil {
		t.Fatalf("must not error on bad project_id: %v", r.Error)
	}
	if b.recallProjectID != uuid.Nil {
		t.Errorf("expected uuid.Nil on parse failure, got %v", b.recallProjectID)
	}
}

// TestRememberForwardsProjectID is the write-path twin of
// TestRecallForwardsProjectID. The entire E2 plumbing collapses if the
// dispatcher drops the field between the hook subprocess and the
// daemon's WriteEntry handler.
func TestRememberForwardsProjectID(t *testing.T) {
	b := &stubBackend{}
	d := NewDispatcher(b)
	wanted := uuid.MustParse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{` +
		`"name":"remember","arguments":{"content":"X","project_id":"` + wanted.String() + `"}}}`
	resp := d.Handle([]byte(body))
	var r Response
	_ = json.Unmarshal(resp, &r)
	if r.Error != nil {
		t.Fatalf("error: %v", r.Error)
	}
	if b.writeProjectID != wanted {
		t.Errorf("expected backend.WriteEntry to receive %v, got %v",
			wanted, b.writeProjectID)
	}
}

// TestEnsureProjectMethod is the daemon-side handler for the custom
// `klio.ensure_project` JSON-RPC method called by the hook subprocess
// before every write/recall. The response must include the resolved
// project_id as a string under the key `project_id`.
func TestEnsureProjectMethod(t *testing.T) {
	id := uuid.MustParse("cccccccc-cccc-cccc-cccc-cccccccccccc")
	b := &stubBackend{ensureID: id}
	d := NewDispatcher(b)
	body := `{"jsonrpc":"2.0","id":1,"method":"klio.ensure_project","params":{` +
		`"git_remote":"git@github.com:klio-tech/klio.git",` +
		`"repo_root_path":"/Users/x/proj",` +
		`"display_name":"klio-tech/klio"}}`
	resp := d.Handle([]byte(body))
	var r Response
	_ = json.Unmarshal(resp, &r)
	if r.Error != nil {
		t.Fatalf("error: %v", r.Error)
	}
	if !b.ensureCalled {
		t.Fatal("backend.EnsureProject was not called")
	}
	if b.ensureGitRemote != "git@github.com:klio-tech/klio.git" {
		t.Errorf("git_remote: got %s", b.ensureGitRemote)
	}
	if b.ensureRepoRootPath != "/Users/x/proj" {
		t.Errorf("repo_root_path: got %s", b.ensureRepoRootPath)
	}
	if b.ensureDisplayName != "klio-tech/klio" {
		t.Errorf("display_name: got %s", b.ensureDisplayName)
	}
	res, ok := r.Result.(map[string]any)
	if !ok {
		t.Fatalf("expected map result, got %T", r.Result)
	}
	if got, _ := res["project_id"].(string); got != id.String() {
		t.Errorf("project_id: got %q, want %q", got, id.String())
	}
}
