package mcp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

type stubBackend struct {
	recallCalled       bool
	recallProject      string
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
	_ context.Context, _, _, _ string, _ int, project string,
) ([]map[string]any, error) {
	s.recallCalled = true
	s.recallProject = project
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

// TestRecallForwardsLegacyProjectID covers the E2 wire contract: when
// the hook runner sends `project_id` (a UUID string) in the arguments
// map, the dispatcher MUST forward that UUID string verbatim to
// backend.Recall's `project` parameter. Without this, the hook-driven
// per-project scoping silently degrades to cross-project recall.
//
// The legacy `project_id` key remains supported as an alias for
// `project` because the hook subprocess (SocketBackend.Recall in
// internal/hooks) emits it that way; E3 added the LLM-facing `project`
// alias on top of that without removing the hook contract.
func TestRecallForwardsLegacyProjectID(t *testing.T) {
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
	if b.recallProject != wanted.String() {
		t.Errorf("expected backend.Recall to receive %q, got %q",
			wanted.String(), b.recallProject)
	}
}

// TestRecallToleratesBadProjectID is the fail-open guarantee: an
// unparseable project_id from a buggy or stale hook client must not 400
// the call. The dispatcher silently falls back to the empty string and
// lets the recall run (cross-project scope). Surfacing a hard error
// here would break the user's session-start context warmup on the rare
// day someone ships a client that mangles uuid strings.
//
// Note: the dispatcher only validates `project_id` (the legacy hook
// alias) as UUID-shaped. `project` (the LLM-facing alias) accepts any
// string verbatim because the engine's recall endpoint already does
// the uuid|remote|"any" resolution on its side.
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
	if b.recallProject != "" {
		t.Errorf("expected empty project on parse failure, got %q", b.recallProject)
	}
}

// TestRecallForwardsProjectString is the E3 contract: the LLM passes
// `project` (a free-form string) in the recall tool's arguments. The
// dispatcher MUST forward the string verbatim to backend.Recall — no
// UUID parsing, no normalisation. The engine's recall endpoint
// resolves uuid|remote|"any" on its side; the bridge is a pure pipe.
func TestRecallForwardsProjectString(t *testing.T) {
	b := &stubBackend{}
	d := NewDispatcher(b)
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{` +
		`"name":"recall","arguments":{"query":"q","project":"git@github.com:klio-tech/klio.git"}}}`
	resp := d.Handle([]byte(body))
	var r Response
	_ = json.Unmarshal(resp, &r)
	if r.Error != nil {
		t.Fatalf("error: %v", r.Error)
	}
	if b.recallProject != "git@github.com:klio-tech/klio.git" {
		t.Errorf("expected git_remote forwarded verbatim, got %q", b.recallProject)
	}
}

// TestRecallForwardsProjectAnyLiteral guards the cross-project widening
// path: when the LLM explicitly passes the literal "any" (because the
// user said "how did we do X in that other repo"), the dispatcher MUST
// forward it verbatim. The engine recognises "any" as the explicit
// cross-project sentinel — collapsing it to empty here would shift
// behaviour silently, and that's exactly the regression this guards.
func TestRecallForwardsProjectAnyLiteral(t *testing.T) {
	b := &stubBackend{}
	d := NewDispatcher(b)
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{` +
		`"name":"recall","arguments":{"query":"q","project":"any"}}}`
	resp := d.Handle([]byte(body))
	var r Response
	_ = json.Unmarshal(resp, &r)
	if r.Error != nil {
		t.Fatalf("error: %v", r.Error)
	}
	if b.recallProject != "any" {
		t.Errorf("expected 'any' forwarded verbatim, got %q", b.recallProject)
	}
}

// TestRecallPrefersProjectOverLegacyAlias documents precedence: if a
// caller somehow sets both `project` and `project_id`, the LLM-facing
// `project` wins. This is the safer default — the LLM is the higher-
// level intent, the hook tag is a lower-level default. A pathological
// caller setting both is a bug elsewhere; we want the bug to surface
// as "the LLM's explicit scope took effect" rather than "the LLM's
// scope was silently overridden by an opaque UUID".
func TestRecallPrefersProjectOverLegacyAlias(t *testing.T) {
	b := &stubBackend{}
	d := NewDispatcher(b)
	uuidArg := uuid.MustParse("dddddddd-dddd-dddd-dddd-dddddddddddd")
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{` +
		`"name":"recall","arguments":{"query":"q",` +
		`"project":"any","project_id":"` + uuidArg.String() + `"}}}`
	resp := d.Handle([]byte(body))
	var r Response
	_ = json.Unmarshal(resp, &r)
	if r.Error != nil {
		t.Fatalf("error: %v", r.Error)
	}
	if b.recallProject != "any" {
		t.Errorf("expected explicit `project` to win, got %q", b.recallProject)
	}
}

// TestRecallAbsentProjectStaysEmpty preserves v0.6 cross-project
// recall when NEITHER `project` nor `project_id` are supplied. We
// deliberately do NOT auto-resolve the bridge's cwd into a project
// here — that would require cwd context the dispatcher doesn't have
// (the daemon's MCP socket isn't tied to a per-call cwd). The hook
// path handles cwd → project resolution upstream and tags the call
// with `project_id`; the direct LLM path defaults to cross-project
// recall, and the LLM can scope explicitly via `project`.
func TestRecallAbsentProjectStaysEmpty(t *testing.T) {
	b := &stubBackend{}
	d := NewDispatcher(b)
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{` +
		`"name":"recall","arguments":{"query":"q"}}}`
	resp := d.Handle([]byte(body))
	var r Response
	_ = json.Unmarshal(resp, &r)
	if r.Error != nil {
		t.Fatalf("error: %v", r.Error)
	}
	if b.recallProject != "" {
		t.Errorf("expected empty project when neither arg present, got %q", b.recallProject)
	}
}

// TestRecallToolSchemaIncludesProject locks the LLM-facing schema: the
// `recall` tool MUST expose a `project` property of type string, with
// a description that names the load-bearing values an LLM should know
// about ("any" and "current project"). Stripping or renaming this
// breaks the agent's ability to scope recall — guarding both the key
// and the description content catches the two ways this regresses.
func TestRecallToolSchemaIncludesProject(t *testing.T) {
	var recall *Tool
	for i := range Tools() {
		t2 := Tools()[i]
		if t2.Name == "recall" {
			recall = &t2
			break
		}
	}
	if recall == nil {
		t.Fatal("recall tool missing from Tools()")
	}
	props, ok := recall.InputSchema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("recall.InputSchema.properties not a map: %T", recall.InputSchema["properties"])
	}
	project, ok := props["project"].(map[string]any)
	if !ok {
		t.Fatalf("recall.InputSchema.properties.project missing or wrong type: %T", props["project"])
	}
	if project["type"] != "string" {
		t.Errorf(`project.type = %v, want "string"`, project["type"])
	}
	desc, _ := project["description"].(string)
	if desc == "" {
		t.Fatal("project.description must not be empty — the LLM relies on it")
	}
	// Guard the two semantic anchors an LLM uses to decide what to pass.
	if !contains(desc, "any") {
		t.Errorf("project.description must mention `any` literal: %q", desc)
	}
	if !contains(desc, "current project") {
		t.Errorf("project.description must mention `current project` default: %q", desc)
	}
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
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
