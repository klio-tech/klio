package daemon

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/klio-tech/bridge/internal/cache"
	"github.com/klio-tech/bridge/internal/cloud"
)

// Daemon implements mcp.Backend.

func (d *Daemon) Recall(
	ctx context.Context, query, spaceSlug, kind string, limit int,
) ([]map[string]any, error) {
	spaceID, err := d.resolveSpace(ctx, spaceSlug)
	if err != nil {
		// Fallback: cache-only across whatever we know
		return rowsToMaps(nil), nil
	}
	if limit <= 0 {
		limit = 10
	}
	entries, err := d.cloud.Recall(ctx, spaceID, cloud.RecallRequest{
		Query: query, Kind: kind, Limit: limit,
	})
	if err != nil {
		// Cloud failed — fall back to local cache
		rows, _ := d.cache.ListBySpace(spaceID, limit)
		return rowsToMaps(rows), nil
	}
	out := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		out = append(out, map[string]any{
			"id":         e.ID,
			"space_id":   e.SpaceID,
			"agent_id":   e.AgentID,
			"kind":       e.Kind,
			"content":    e.Content,
			"confidence": e.Confidence,
			"created_at": e.CreatedAt,
		})
		_ = d.cache.PutEntry(cache.CachedEntry{
			ID:           e.ID,
			SpaceID:      e.SpaceID,
			Kind:         e.Kind,
			Content:      e.Content,
			Confidence:   e.Confidence,
			CreatedAt:    e.CreatedAt,
			SupersededBy: e.SupersededBy,
		})
	}
	return out, nil
}

func (d *Daemon) WriteEntry(
	ctx context.Context, kind, content, spaceSlug string, metadata map[string]any,
) (map[string]any, error) {
	spaceID, err := d.resolveSpace(ctx, spaceSlug)
	if err != nil {
		return nil, err
	}
	// Distinguish kind. The MCP dispatcher uses tool-name as kind; map it
	// to the engine's entry kind.
	engineKind := kind
	switch kind {
	case "remember":
		engineKind = "memory"
	case "observe":
		engineKind = "observation"
	case "decide":
		engineKind = "decision"
	}
	e, err := d.cloud.WriteEntry(ctx, spaceID, cloud.EntryWrite{
		Kind: engineKind, Content: content, Metadata: metadata, Confidence: 1.0,
	})
	if err != nil {
		// Queue offline
		_ = d.cache.EnqueuePendingWrite(spaceID, engineKind, content, metadata)
		return map[string]any{
			"id":      uuid.New(),
			"kind":    engineKind,
			"content": content,
			"queued":  true,
		}, nil
	}
	_ = d.cache.PutEntry(cache.CachedEntry{
		ID:         e.ID,
		SpaceID:    e.SpaceID,
		Kind:       e.Kind,
		Content:    e.Content,
		Confidence: e.Confidence,
		CreatedAt:  e.CreatedAt,
	})
	return map[string]any{"id": e.ID, "kind": e.Kind, "content": e.Content}, nil
}

func (d *Daemon) ListSpaces(ctx context.Context) ([]map[string]any, error) {
	spaces, err := d.cloud.ListSpaces(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(spaces))
	for _, s := range spaces {
		out = append(out, map[string]any{
			"id": s.ID, "name": s.Name, "slug": s.Slug,
		})
	}
	return out, nil
}

func (d *Daemon) SwitchSpace(ctx context.Context, slug string) error {
	id, err := d.resolveSpace(ctx, slug)
	if err != nil {
		return err
	}
	d.SetActiveSpace(id)
	return nil
}

// RequestAccess submits a request to the engine for the daemon's own agent
// to gain `scope` access to space identified by `slug`. The user sees the
// pending request in the trust app and approves/denies there.
func (d *Daemon) RequestAccess(ctx context.Context, slug, scope string) error {
	if slug == "" {
		return errors.New("request_access: space slug required")
	}
	if scope == "" {
		scope = "read"
	}
	agentBytes, err := d.keys.Get("agent_id")
	if err != nil || len(agentBytes) == 0 {
		return errors.New("request_access: daemon has no agent_id; run klio init first")
	}
	agentID, perr := uuid.Parse(string(agentBytes))
	if perr != nil {
		return fmt.Errorf("request_access: invalid agent_id in keychain: %w", perr)
	}
	if _, err := d.cloud.RequestAccess(ctx, agentID, slug, scope, ""); err != nil {
		return err
	}
	return nil
}

func (d *Daemon) ActiveSpaceInfo(ctx context.Context) (map[string]any, error) {
	id, ok := d.ActiveSpace()
	if !ok {
		return map[string]any{"slug": "default"}, nil
	}
	return map[string]any{"id": id}, nil
}

func rowsToMaps(rows []cache.CachedEntry) []map[string]any {
	out := make([]map[string]any, 0, len(rows))
	for _, e := range rows {
		out = append(out, map[string]any{
			"id":         e.ID,
			"space_id":   e.SpaceID,
			"kind":       e.Kind,
			"content":    e.Content,
			"confidence": e.Confidence,
			"created_at": e.CreatedAt,
		})
	}
	return out
}
