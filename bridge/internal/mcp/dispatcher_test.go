package mcp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

type stubBackend struct {
	recallCalled   bool
	writeCalled    bool
	writeKind      string
	listCalled     bool
	switchedTo     string
	requestedSlug  string
	requestedScope string
}

func (s *stubBackend) Recall(_ context.Context, _, _, _ string, _ int) ([]map[string]any, error) {
	s.recallCalled = true
	return []map[string]any{{"content": "fake result", "kind": "memory"}}, nil
}

func (s *stubBackend) WriteEntry(_ context.Context, kind, content, _ string, _ map[string]any) (map[string]any, error) {
	s.writeCalled = true
	s.writeKind = kind
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
