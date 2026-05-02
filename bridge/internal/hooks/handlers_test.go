package hooks

import (
	"strings"
	"testing"
)

type fakeBackend struct {
	recallResult []map[string]any
	written      []string
}

func (f *fakeBackend) Recall(_ string, _ int) ([]map[string]any, error) {
	return f.recallResult, nil
}

func (f *fakeBackend) WriteEntry(kind, content string, _ map[string]any) (map[string]any, error) {
	f.written = append(f.written, kind+":"+content)
	return map[string]any{"id": "x", "kind": kind, "content": content}, nil
}

func (f *fakeBackend) IngestTranscript(_ string, _ []map[string]any) (map[string]any, error) {
	return nil, nil
}

func TestSessionStartReturnsContext(t *testing.T) {
	b := &fakeBackend{
		recallResult: []map[string]any{
			{"kind": "memory", "content": "User prefers TypeScript."},
			{"kind": "decision", "content": "Using Bun, not npm."},
		},
	}
	resp, err := SessionStart(b, Payload{Cwd: "/Users/x/proj"})
	if err != nil {
		t.Fatalf("SessionStart: %v", err)
	}
	ctx := resp.HookSpecificOutput["additionalContext"].(string)
	if !strings.Contains(ctx, "TypeScript") {
		t.Fatalf("missing memory in context: %s", ctx)
	}
	if !strings.Contains(ctx, "Bun") {
		t.Fatalf("missing decision in context: %s", ctx)
	}
}

func TestSessionStartEmptyWhenNoEntries(t *testing.T) {
	b := &fakeBackend{recallResult: []map[string]any{}}
	resp, err := SessionStart(b, Payload{})
	if err != nil {
		t.Fatal(err)
	}
	if resp.HookSpecificOutput != nil {
		t.Fatalf("expected nil output, got %v", resp.HookSpecificOutput)
	}
}

func TestUserPromptDetectsRememberTrigger(t *testing.T) {
	b := &fakeBackend{}
	_, _ = UserPromptSubmit(b, Payload{
		UserMessage: "remember that I prefer TypeScript over JavaScript",
	})
	if len(b.written) != 1 {
		t.Fatalf("expected 1 write, got %d", len(b.written))
	}
	if !strings.Contains(b.written[0], "TypeScript over JavaScript") {
		t.Fatalf("got %s", b.written[0])
	}
	if !strings.HasPrefix(b.written[0], "remember:") {
		t.Fatalf("expected remember kind, got %s", b.written[0])
	}
}

func TestUserPromptIgnoresNonTrigger(t *testing.T) {
	b := &fakeBackend{}
	_, _ = UserPromptSubmit(b, Payload{UserMessage: "what is the weather"})
	if len(b.written) != 0 {
		t.Fatalf("unexpected writes: %v", b.written)
	}
}

func TestPostToolLogsObservation(t *testing.T) {
	b := &fakeBackend{}
	_, _ = PostToolUse(b, Payload{
		ToolName:   "Edit",
		SessionID:  "abc",
		ToolInput:  []byte(`{"file":"x.ts"}`),
	})
	if len(b.written) != 1 {
		t.Fatalf("expected 1 observation")
	}
	if !strings.HasPrefix(b.written[0], "observe:") {
		t.Fatalf("expected observe, got %s", b.written[0])
	}
	if !strings.Contains(b.written[0], "Edit") {
		t.Fatal("tool name missing")
	}
}

func TestSessionStopWithMissingTranscriptIsSafe(t *testing.T) {
	b := &fakeBackend{}
	_, err := SessionStop(b, Payload{SessionID: "x", TranscriptPath: ""})
	if err != nil {
		t.Fatalf("SessionStop must not error on missing transcript: %v", err)
	}
}
