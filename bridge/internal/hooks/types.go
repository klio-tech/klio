// Package hooks implements the six Claude Code hook subcommands.
//
// Each hook reads a JSON payload from stdin, performs an async operation
// against the daemon, and either writes a hook response to stdout (for hooks
// that augment the session) or exits silently.
package hooks

import "encoding/json"

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
type Backend interface {
	Recall(query string, limit int) ([]map[string]any, error)
	WriteEntry(kind, content string, metadata map[string]any) (map[string]any, error)
	IngestTranscript(sessionID string, messages []map[string]any) (map[string]any, error)
}
