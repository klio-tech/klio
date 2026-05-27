package cloud

import (
	"time"

	"github.com/google/uuid"
)

type ProvisionRequest struct {
	AgentKind   string    `json:"agent_kind"`
	InstallID   uuid.UUID `json:"install_id"`
	DisplayName string    `json:"display_name,omitempty"`
	Email       string    `json:"email,omitempty"`
}

type ProvisionResponse struct {
	UserID         uuid.UUID `json:"user_id"`
	AgentID        uuid.UUID `json:"agent_id"`
	APIKey         string    `json:"api_key"`
	Claimed        bool      `json:"claimed"`
	DefaultSpaceID uuid.UUID `json:"default_space_id"`
}

type RefreshResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
}

type Space struct {
	ID             uuid.UUID `json:"id"`
	Name           string    `json:"name"`
	Slug           string    `json:"slug"`
	EmbeddingModel string    `json:"embedding_model"`
	EmbeddingDim   int       `json:"embedding_dim"`
	CreatedAt      time.Time `json:"created_at"`
}

type ReembedResponse struct {
	SpaceID          uuid.UUID `json:"space_id"`
	FromModel        string    `json:"from_model"`
	FromDim          int       `json:"from_dim"`
	ToModel          string    `json:"to_model"`
	ToDim            int       `json:"to_dim"`
	EntriesProcessed int       `json:"entries_processed"`
}

type Entry struct {
	ID           uuid.UUID      `json:"id"`
	SpaceID      uuid.UUID      `json:"space_id"`
	AgentID      uuid.UUID      `json:"agent_id"`
	Kind         string         `json:"kind"`
	Content      string         `json:"content"`
	Metadata     map[string]any `json:"metadata,omitempty"`
	Confidence   float64        `json:"confidence"`
	CreatedAt    time.Time      `json:"created_at"`
	SupersededBy *uuid.UUID     `json:"superseded_by,omitempty"`
}

// EntryWrite is the body of POST /v1/spaces/{id}/entries.
//
// ProjectID, when non-nil, tags the resulting entries row with the engine
// project_id resolved by the bridge's project.Cache + EnsureProject flow.
// A nil pointer serialises as the JSON field being absent, which the
// engine treats as NULL — and NULL-tagged entries always surface in every
// project's recall scope (B2's invariant).
//
// Pointer-not-value is load-bearing: uuid.UUID is a [16]byte and the
// `encoding/json` `omitempty` rule does NOT treat a zero-valued array as
// empty (a value-typed field with `omitempty` would still serialise as
// "00000000-0000-0000-0000-000000000000", which the engine's C1 path-level
// validators reject). The pointer form is the only way to send "absent"
// over the wire from Go.
type EntryWrite struct {
	Kind       string         `json:"kind"`
	Content    string         `json:"content"`
	Metadata   map[string]any `json:"metadata,omitempty"`
	Confidence float64        `json:"confidence,omitempty"`
	ProjectID  *uuid.UUID     `json:"project_id,omitempty"`
}

type RecallRequest struct {
	Query string `json:"query"`
	Kind  string `json:"kind,omitempty"`
	Limit int    `json:"limit,omitempty"`
	// Project is the optional per-call project filter understood by the
	// engine's recall endpoint (B3 semantics): a project UUID string, a
	// `git_remote` literal, or empty to disable filtering.
	//
	// `omitempty` is load-bearing — an empty string would shift the
	// engine from "no filter" to "exact match on empty string" and
	// produce zero results. E3 will populate this from the MCP recall
	// tool's resolved project key; E1 just gets the field onto the wire.
	Project string `json:"project,omitempty"`
}

// ensureProjectRequest is the wire format for POST /v1/projects/ensure.
//
// All three fields use `omitempty` so the bridge can pass empty
// strings to mean "absent" without tripping the engine's min_length=1
// validation. The engine 422s if BOTH git_remote AND repo_root_path
// are absent — bridge callers are expected to guarantee at least one
// is non-empty (project.Resolve does this).
type ensureProjectRequest struct {
	GitRemote    string `json:"git_remote,omitempty"`
	RepoRootPath string `json:"repo_root_path,omitempty"`
	DisplayName  string `json:"display_name"`
}

type ensureProjectResponse struct {
	ID uuid.UUID `json:"id"`
}

// PromoteRequest is the wire format for
// POST /v1/projects/{id}/promote.
//
// Exactly one of SpaceID / EmbeddingModel must be non-zero — the
// engine's handler XOR-validates and 422s if both/neither are set.
// The CLI layer enforces this before the call, but we still send the
// raw fields so any future caller (or test) hits the same engine path.
//
// `omitempty` is load-bearing for both fields: an uninhibited
// `uuid.Nil` for SpaceID would deserialise as a legal UUID on the
// engine side (and override the embedding_model path); an empty
// EmbeddingModel string would trip the engine's `min_length=1` schema
// gate. Both fields are pointer-like (string / uuid.UUID) and the
// zero values must be elided to mean "absent".
type PromoteRequest struct {
	SpaceID        string `json:"space_id,omitempty"`
	EmbeddingModel string `json:"embedding_model,omitempty"`
}

// PromoteResponse is the wire format returned by
// POST /v1/projects/{id}/promote.
//
// Both ids are echoed back so the CLI can confirm the assignment
// without a follow-up GET. DedicatedSpaceID is guaranteed non-nil by
// the engine handler.
type PromoteResponse struct {
	ProjectID        uuid.UUID `json:"project_id"`
	DedicatedSpaceID uuid.UUID `json:"dedicated_space_id"`
}
