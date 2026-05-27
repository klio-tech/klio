// Package hooks implements the six Claude Code hook subcommands.
//
// Each hook reads a JSON payload from stdin, performs an async operation
// against the daemon, and either writes a hook response to stdout (for hooks
// that augment the session) or exits silently.
package hooks

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
)

// Payload is the union of fields Claude Code sends to hooks. Not every field
// is present on every event; hooks read what they need.
type Payload struct {
	HookEventName  string          `json:"hook_event_name"`
	SessionID      string          `json:"session_id,omitempty"`
	TranscriptPath string          `json:"transcript_path,omitempty"`
	Cwd            string          `json:"cwd,omitempty"`
	UserMessage    string          `json:"prompt,omitempty"`
	ToolName       string          `json:"tool_name,omitempty"`
	ToolInput      json.RawMessage `json:"tool_input,omitempty"`
	ToolResponse   json.RawMessage `json:"tool_response,omitempty"`
	Source         string          `json:"source,omitempty"`
}

// Response is the JSON body Claude Code expects from hooks that want to
// influence the session.
type Response struct {
	HookSpecificOutput map[string]any `json:"hookSpecificOutput,omitempty"`
	Decision           string         `json:"decision,omitempty"` // "block" | "approve" | ""
	Reason             string         `json:"reason,omitempty"`
}

// Backend is the abstraction the hook handlers call. The production backend
// is a thin wrapper over the daemon's MCP request channel; tests inject
// in-memory fakes.
//
// projectID carries the engine project_id that hook handlers resolved via
// project.Cache + EnsureProject. Passing uuid.Nil is the explicit "no
// project" signal: it serialises as `project_id` omitted on the wire (via
// `omitempty`), and the engine treats absent project_id as NULL, which the
// recall layer surfaces in every project's recall scope. Hook handlers
// MUST pass uuid.Nil on EnsureProject failure rather than aborting the
// write — losing the project tag is acceptable, losing the entry is not.
type Backend interface {
	Recall(query string, limit int, projectID uuid.UUID) ([]map[string]any, error)
	WriteEntry(
		kind, content string, metadata map[string]any, projectID uuid.UUID,
	) (map[string]any, error)
	IngestTranscript(
		sessionID string, messages []map[string]any, projectID uuid.UUID,
	) (map[string]any, error)
	// EnsureProject reaches the engine's POST /v1/projects/ensure via the
	// daemon and returns the resolved project_id. Hook handlers call this
	// after project.Cache.Resolve when at least one of gitRemote or
	// repoRootPath is non-empty. On network or 5xx failure callers should
	// fail open (continue with uuid.Nil) — the write must not be blocked
	// on a project tag.
	EnsureProject(
		ctx context.Context, gitRemote, repoRootPath, displayName string,
	) (uuid.UUID, error)
}
