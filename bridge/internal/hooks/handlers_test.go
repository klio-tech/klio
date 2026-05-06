package hooks

import (
	"fmt"
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
		ToolName:     "Edit",
		SessionID:    "abc",
		ToolInput:    []byte(`{"file":"x.ts"}`),
		ToolResponse: []byte(`{"ok":true}`),
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

// TestPostToolUseCapturesBothInputAndResponse pins the contract that
// observations carry the full tool I/O — anything less starves the
// curator's FactExtractor of signal.
func TestPostToolUseCapturesBothInputAndResponse(t *testing.T) {
	b := &fakeBackend{}
	_, _ = PostToolUse(b, Payload{
		ToolName:     "Bash",
		SessionID:    "s1",
		ToolInput:    []byte(`{"command":"ls -la","description":"list files"}`),
		ToolResponse: []byte(`{"stdout":"file1\nfile2\n","exit_code":0}`),
	})
	if len(b.written) != 1 {
		t.Fatalf("expected 1 observation, got %d", len(b.written))
	}
	got := b.written[0]
	if !strings.Contains(got, "Used tool Bash") {
		t.Fatalf("missing tool name header: %s", got)
	}
	if !strings.Contains(got, "input:") {
		t.Fatalf("missing input: line: %s", got)
	}
	if !strings.Contains(got, `"command":"ls -la"`) {
		t.Fatalf("missing input payload: %s", got)
	}
	if !strings.Contains(got, "response:") {
		t.Fatalf("missing response: line: %s", got)
	}
	if !strings.Contains(got, `"exit_code":0`) {
		t.Fatalf("missing response payload: %s", got)
	}
}

// TestPostToolUseTruncatesLargeFields asserts each field is truncated
// independently to the per-field cap with a clear "(truncated, original
// N bytes)" suffix — this is what made the < 400-byte silent drop in
// pre-0.5.4 so harmful: there was no signal that data was lost.
func TestPostToolUseTruncatesLargeFields(t *testing.T) {
	b := &fakeBackend{}
	bigPayload := make([]byte, 5000)
	for i := range bigPayload {
		bigPayload[i] = 'a'
	}
	_, _ = PostToolUse(b, Payload{
		ToolName:     "Bash",
		SessionID:    "s2",
		ToolInput:    bigPayload,
		ToolResponse: []byte(`{"ok":true}`),
	})
	if len(b.written) != 1 {
		t.Fatalf("expected 1 observation, got %d", len(b.written))
	}
	got := b.written[0]
	// First 2000 chars of the input should appear.
	if !strings.Contains(got, strings.Repeat("a", maxObservationFieldChars)) {
		t.Fatalf("expected first %d bytes of input, got: %s",
			maxObservationFieldChars, got[:200])
	}
	// More than 2000 'a's would mean we didn't truncate. Allow exactly
	// the cap, never more.
	if strings.Contains(got, strings.Repeat("a", maxObservationFieldChars+1)) {
		t.Fatalf("input exceeded truncation cap of %d", maxObservationFieldChars)
	}
	// Truncation marker must call out the original size honestly.
	expectedMarker := fmt.Sprintf("(truncated, original %d bytes)", len(bigPayload))
	if !strings.Contains(got, expectedMarker) {
		t.Fatalf("missing truncation marker %q in: %s", expectedMarker, got)
	}
}

// TestPostToolUseHandlesEmptyResponse covers the rare-but-real case
// where a tool errors before producing output. We must still emit an
// observation, with a clear `response: (none)` placeholder, never a
// panic and never a missing line.
func TestPostToolUseHandlesEmptyResponse(t *testing.T) {
	b := &fakeBackend{}
	_, _ = PostToolUse(b, Payload{
		ToolName:  "Edit",
		SessionID: "s3",
		ToolInput: []byte(`{"file":"x.ts"}`),
		// ToolResponse intentionally nil
	})
	if len(b.written) != 1 {
		t.Fatalf("expected 1 observation, got %d", len(b.written))
	}
	got := b.written[0]
	if !strings.Contains(got, "input:") {
		t.Fatalf("missing input: line: %s", got)
	}
	if !strings.Contains(got, "response: (none)") {
		t.Fatalf("expected explicit (none) placeholder, got: %s", got)
	}
}

func TestSessionStopWithMissingTranscriptIsSafe(t *testing.T) {
	b := &fakeBackend{}
	_, err := SessionStop(b, Payload{SessionID: "x", TranscriptPath: ""})
	if err != nil {
		t.Fatalf("SessionStop must not error on missing transcript: %v", err)
	}
}
