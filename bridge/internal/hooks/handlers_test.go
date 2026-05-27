package hooks

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"

	"github.com/klio-tech/bridge/internal/project"
)

type fakeBackend struct {
	recallResult []map[string]any
	// written captures kind + content; lastWriteProjectID captures the
	// project_id passed on the final WriteEntry call.
	written            []string
	lastWriteProjectID uuid.UUID
	lastRecallProject  uuid.UUID
	// ensureID is the project_id returned from EnsureProject; ensureErr
	// (if non-nil) overrides ensureID and is returned instead.
	ensureID            uuid.UUID
	ensureErr           error
	lastEnsureCalls     int32
	lastEnsureGitRemote string
	lastEnsureRepoRoot  string
	lastEnsureDisplay   string
}

func (f *fakeBackend) Recall(_ string, _ int, projectID uuid.UUID) ([]map[string]any, error) {
	f.lastRecallProject = projectID
	return f.recallResult, nil
}

func (f *fakeBackend) WriteEntry(
	kind, content string, _ map[string]any, projectID uuid.UUID,
) (map[string]any, error) {
	f.written = append(f.written, kind+":"+content)
	f.lastWriteProjectID = projectID
	return map[string]any{"id": "x", "kind": kind, "content": content}, nil
}

func (f *fakeBackend) IngestTranscript(
	_ string, _ []map[string]any, _ uuid.UUID,
) (map[string]any, error) {
	return nil, nil
}

func (f *fakeBackend) EnsureProject(
	_ context.Context, gitRemote, repoRootPath, displayName string,
) (uuid.UUID, error) {
	atomic.AddInt32(&f.lastEnsureCalls, 1)
	f.lastEnsureGitRemote = gitRemote
	f.lastEnsureRepoRoot = repoRootPath
	f.lastEnsureDisplay = displayName
	if f.ensureErr != nil {
		return uuid.Nil, f.ensureErr
	}
	return f.ensureID, nil
}

func TestSessionStartReturnsContext(t *testing.T) {
	b := &fakeBackend{
		recallResult: []map[string]any{
			{"kind": "memory", "content": "User prefers TypeScript."},
			{"kind": "decision", "content": "Using Bun, not npm."},
		},
	}
	resp, err := SessionStart(b, Payload{Cwd: "/Users/x/proj"}, uuid.Nil)
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
	resp, err := SessionStart(b, Payload{}, uuid.Nil)
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
	}, uuid.Nil)
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
	_, _ = UserPromptSubmit(b, Payload{UserMessage: "what is the weather"}, uuid.Nil)
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
	}, uuid.Nil)
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
	}, uuid.Nil)
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
	}, uuid.Nil)
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
	}, uuid.Nil)
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
	_, err := SessionStop(b, Payload{SessionID: "x", TranscriptPath: ""}, uuid.Nil)
	if err != nil {
		t.Fatalf("SessionStop must not error on missing transcript: %v", err)
	}
}

// runGitInDir is a test helper that runs git with a hermetic environment
// — no user-level config, no global hooks, deterministic identity. Tests
// that exercise project.Resolve need a real git repo with a real remote
// configured; runGitInDir provides one safely.
func runGitInDir(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t",
		"GIT_AUTHOR_EMAIL=t@t",
		"GIT_COMMITTER_NAME=t",
		"GIT_COMMITTER_EMAIL=t@t",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
}

// TestWriteHookTagsEntryWithProjectID is the headline E2 contract:
// a write-path hook fired from a real git repo flows through
// project.Cache.Resolve → backend.EnsureProject → backend.WriteEntry
// with the resolved project_id, in that order. Without this, every
// memory entry the bridge writes lands NULL-tagged and the engine has
// no way to distinguish entries by their originating project.
func TestWriteHookTagsEntryWithProjectID(t *testing.T) {
	expectedID := uuid.MustParse("11111111-1111-1111-1111-111111111111")
	backend := &fakeBackend{ensureID: expectedID}
	cache := project.NewCache(8)

	dir := t.TempDir()
	runGitInDir(t, dir, "init", "-b", "main", "-q")
	runGitInDir(t, dir, "remote", "add", "origin", "git@github.com:klio-tech/klio.git")

	stdin := bytes.NewBufferString(`{
		"hook_event_name": "UserPromptSubmit",
		"cwd": ` + jsonString(dir) + `,
		"prompt": "remember tabs > spaces"
	}`)
	var stdout, stderr bytes.Buffer
	exit := Run("user-prompt", backend, cache, stdin, &stdout, &stderr)
	if exit != 0 {
		t.Fatalf("Run exit=%d stderr=%s", exit, stderr.String())
	}
	if backend.lastWriteProjectID != expectedID {
		t.Errorf("WriteEntry project_id: got %v, want %v",
			backend.lastWriteProjectID, expectedID)
	}
	if got := atomic.LoadInt32(&backend.lastEnsureCalls); got != 1 {
		t.Errorf("expected 1 EnsureProject call, got %d", got)
	}
	if !strings.Contains(backend.lastEnsureGitRemote, "klio-tech/klio") {
		t.Errorf("unexpected git_remote: %s", backend.lastEnsureGitRemote)
	}
	if backend.lastEnsureDisplay == "" {
		t.Error("display_name must be non-empty")
	}
	if len(backend.written) != 1 {
		t.Fatalf("expected 1 write, got %d", len(backend.written))
	}
}

// TestWriteHookFromNonGitDirSkipsEnsure covers the safe-default path:
// when cwd has no git history at all, project.Resolve returns a Key with
// both GitRemote and RepoRootPath empty. The runner MUST detect this
// and short-circuit before calling EnsureProject (which would 422 the
// engine), passing uuid.Nil to WriteEntry. The write still goes through
// so the entry isn't lost — it just lands NULL-tagged, surfacing under
// every project's recall scope.
func TestWriteHookFromNonGitDirSkipsEnsure(t *testing.T) {
	backend := &fakeBackend{
		// Deliberately set a non-Nil ensureID — if EnsureProject is
		// erroneously called, the test will catch the project_id
		// leak into WriteEntry.
		ensureID: uuid.MustParse("22222222-2222-2222-2222-222222222222"),
	}
	cache := project.NewCache(8)
	dir := t.TempDir() // no `git init`

	stdin := bytes.NewBufferString(`{
		"hook_event_name": "UserPromptSubmit",
		"cwd": ` + jsonString(dir) + `,
		"prompt": "remember semantic versioning is great"
	}`)
	var stdout, stderr bytes.Buffer
	exit := Run("user-prompt", backend, cache, stdin, &stdout, &stderr)
	if exit != 0 {
		t.Fatalf("Run exit=%d stderr=%s", exit, stderr.String())
	}
	if got := atomic.LoadInt32(&backend.lastEnsureCalls); got != 0 {
		t.Errorf("expected 0 EnsureProject calls, got %d", got)
	}
	if backend.lastWriteProjectID != uuid.Nil {
		t.Errorf("expected uuid.Nil project_id, got %v", backend.lastWriteProjectID)
	}
	if len(backend.written) != 1 {
		t.Fatalf("expected the write to still go through, got %d", len(backend.written))
	}
}

// TestWriteHookFailsOpenOnEnsureError is the production-readiness pin:
// EnsureProject is a network call; transient failures (5xx, dropped
// connection, expired refresh token) MUST NOT block the write. The hook
// fails open — write proceeds with uuid.Nil, entry is preserved.
//
// Without this, an api.klio.tech outage would silently corrupt the
// user's session memory by dropping every write that fires during the
// outage. With it, writes degrade to NULL-tagged entries and recover
// fully when EnsureProject succeeds on the next hook fire.
func TestWriteHookFailsOpenOnEnsureError(t *testing.T) {
	backend := &fakeBackend{
		ensureErr: errors.New("cloud: 503 service unavailable"),
		ensureID:  uuid.MustParse("33333333-3333-3333-3333-333333333333"),
	}
	cache := project.NewCache(8)

	dir := t.TempDir()
	runGitInDir(t, dir, "init", "-b", "main", "-q")
	runGitInDir(t, dir, "remote", "add", "origin", "git@github.com:klio-tech/klio.git")

	stdin := bytes.NewBufferString(`{
		"hook_event_name": "UserPromptSubmit",
		"cwd": ` + jsonString(dir) + `,
		"prompt": "remember pgvector requires HNSW indexes"
	}`)
	var stdout, stderr bytes.Buffer
	exit := Run("user-prompt", backend, cache, stdin, &stdout, &stderr)
	if exit != 0 {
		t.Fatalf("Run exit=%d stderr=%s", exit, stderr.String())
	}
	if got := atomic.LoadInt32(&backend.lastEnsureCalls); got != 1 {
		t.Errorf("expected 1 EnsureProject attempt, got %d", got)
	}
	if backend.lastWriteProjectID != uuid.Nil {
		t.Errorf("fail-open contract: WriteEntry must receive uuid.Nil "+
			"on EnsureProject error, got %v", backend.lastWriteProjectID)
	}
	if len(backend.written) != 1 {
		t.Fatalf("write must still go through (fail open), got %d writes",
			len(backend.written))
	}
	if !strings.Contains(stderr.String(), "EnsureProject") {
		t.Errorf("expected EnsureProject error in stderr, got: %s", stderr.String())
	}
}

// TestWriteHookWithNilCacheSkipsResolve verifies the nil-cache opt-out
// path. Production may run with cache disabled (legacy / fallback /
// failure modes); the runner must treat nil cache identically to "no
// project context" — uuid.Nil, no EnsureProject, write goes through.
func TestWriteHookWithNilCacheSkipsResolve(t *testing.T) {
	backend := &fakeBackend{
		ensureID: uuid.MustParse("44444444-4444-4444-4444-444444444444"),
	}
	stdin := bytes.NewBufferString(`{
		"hook_event_name": "UserPromptSubmit",
		"cwd": "/some/where",
		"prompt": "remember caching matters"
	}`)
	var stdout, stderr bytes.Buffer
	exit := Run("user-prompt", backend, nil, stdin, &stdout, &stderr)
	if exit != 0 {
		t.Fatalf("Run exit=%d stderr=%s", exit, stderr.String())
	}
	if got := atomic.LoadInt32(&backend.lastEnsureCalls); got != 0 {
		t.Errorf("nil cache must not invoke EnsureProject; got %d calls", got)
	}
	if backend.lastWriteProjectID != uuid.Nil {
		t.Errorf("nil cache must pass uuid.Nil; got %v", backend.lastWriteProjectID)
	}
}

// jsonString safely embeds a path in a JSON string literal for the
// fixture payloads above. t.TempDir() can contain characters that
// `fmt.Sprintf("%q", s)` doesn't always quote correctly for JSON
// (it uses Go escape rules, which differ in edge cases for control
// chars and Unicode). For the dir strings these tests produce, %q is
// safe — but the named helper makes intent explicit.
func jsonString(s string) string {
	return fmt.Sprintf("%q", s)
}
