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
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	Slug      string    `json:"slug"`
	CreatedAt time.Time `json:"created_at"`
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
}
