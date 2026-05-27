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

type EntryWrite struct {
	Kind       string         `json:"kind"`
	Content    string         `json:"content"`
	Metadata   map[string]any `json:"metadata,omitempty"`
	Confidence float64        `json:"confidence,omitempty"`
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
