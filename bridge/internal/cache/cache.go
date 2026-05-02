// Package cache is the daemon's local SQLite-backed mirror.
package cache

import (
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	_ "github.com/mattn/go-sqlite3"
)

//go:embed schema.sql
var schemaSQL string

// CachedEntry mirrors a recent Entry from the cloud.
type CachedEntry struct {
	ID           uuid.UUID
	SpaceID      uuid.UUID
	Kind         string
	Content      string
	Metadata     map[string]any
	Confidence   float64
	CreatedAt    time.Time
	SupersededBy *uuid.UUID
}

// PendingWrite is an entry queued during offline periods.
type PendingWrite struct {
	ID       int64
	SpaceID  uuid.UUID
	Kind     string
	Content  string
	Metadata map[string]any
}

// Cache wraps a SQLite database file.
type Cache struct {
	db *sql.DB
}

// Open creates or opens the cache database at path.
func Open(path string) (*Cache, error) {
	db, err := sql.Open("sqlite3", path+"?_journal=WAL&_foreign_keys=on")
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(schemaSQL); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Cache{db: db}, nil
}

func (c *Cache) Close() error { return c.db.Close() }

// PutEntry upserts a single CachedEntry.
func (c *Cache) PutEntry(e CachedEntry) error {
	var metaJSON sql.NullString
	if len(e.Metadata) > 0 {
		body, err := json.Marshal(e.Metadata)
		if err != nil {
			return err
		}
		metaJSON = sql.NullString{String: string(body), Valid: true}
	}
	var supersededBy sql.NullString
	if e.SupersededBy != nil {
		supersededBy = sql.NullString{String: e.SupersededBy.String(), Valid: true}
	}
	_, err := c.db.Exec(
		`INSERT OR REPLACE INTO entries(id, space_id, kind, content, metadata_json,
		    confidence, superseded_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		e.ID.String(), e.SpaceID.String(), e.Kind, e.Content,
		metaJSON, e.Confidence, supersededBy,
	)
	return err
}

// GetEntry fetches a single entry by id.
func (c *Cache) GetEntry(id uuid.UUID) (*CachedEntry, error) {
	row := c.db.QueryRow(
		`SELECT id, space_id, kind, content, metadata_json, confidence
		 FROM entries WHERE id = ?`,
		id.String(),
	)
	var (
		idStr, spaceStr, kind, content string
		metaJSON                       sql.NullString
		conf                           float64
	)
	if err := row.Scan(&idStr, &spaceStr, &kind, &content, &metaJSON, &conf); err != nil {
		return nil, err
	}
	e := &CachedEntry{
		ID:         uuid.MustParse(idStr),
		SpaceID:    uuid.MustParse(spaceStr),
		Kind:       kind,
		Content:    content,
		Confidence: conf,
	}
	if metaJSON.Valid {
		_ = json.Unmarshal([]byte(metaJSON.String), &e.Metadata)
	}
	return e, nil
}

// ListBySpace returns the most-recent entries for a space, up to limit.
func (c *Cache) ListBySpace(spaceID uuid.UUID, limit int) ([]CachedEntry, error) {
	rows, err := c.db.Query(
		`SELECT id, space_id, kind, content, metadata_json, confidence
		 FROM entries WHERE space_id = ?
		 ORDER BY created_at DESC LIMIT ?`,
		spaceID.String(), limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CachedEntry
	for rows.Next() {
		var (
			idStr, spaceStr, kind, content string
			metaJSON                       sql.NullString
			conf                           float64
		)
		if err := rows.Scan(&idStr, &spaceStr, &kind, &content, &metaJSON, &conf); err != nil {
			return nil, err
		}
		e := CachedEntry{
			ID:         uuid.MustParse(idStr),
			SpaceID:    uuid.MustParse(spaceStr),
			Kind:       kind,
			Content:    content,
			Confidence: conf,
		}
		if metaJSON.Valid {
			_ = json.Unmarshal([]byte(metaJSON.String), &e.Metadata)
		}
		out = append(out, e)
	}
	return out, nil
}

// EnqueuePendingWrite stores a write for later flush when the cloud is reachable.
func (c *Cache) EnqueuePendingWrite(
	spaceID uuid.UUID, kind, content string, metadata map[string]any,
) error {
	var metaJSON sql.NullString
	if len(metadata) > 0 {
		body, err := json.Marshal(metadata)
		if err != nil {
			return err
		}
		metaJSON = sql.NullString{String: string(body), Valid: true}
	}
	_, err := c.db.Exec(
		`INSERT INTO pending_writes(space_id, kind, content, metadata_json) VALUES (?, ?, ?, ?)`,
		spaceID.String(), kind, content, metaJSON,
	)
	return err
}

// DrainPending pops up to limit pending writes (FIFO) and removes them from the queue.
func (c *Cache) DrainPending(limit int) ([]PendingWrite, error) {
	tx, err := c.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.Query(
		`SELECT id, space_id, kind, content, metadata_json
		 FROM pending_writes ORDER BY id LIMIT ?`,
		limit,
	)
	if err != nil {
		return nil, err
	}
	var out []PendingWrite
	var ids []int64
	for rows.Next() {
		var p PendingWrite
		var spaceStr string
		var metaJSON sql.NullString
		if err := rows.Scan(&p.ID, &spaceStr, &p.Kind, &p.Content, &metaJSON); err != nil {
			return nil, err
		}
		p.SpaceID = uuid.MustParse(spaceStr)
		if metaJSON.Valid {
			_ = json.Unmarshal([]byte(metaJSON.String), &p.Metadata)
		}
		out = append(out, p)
		ids = append(ids, p.ID)
	}
	rows.Close()
	for _, id := range ids {
		if _, err := tx.Exec(`DELETE FROM pending_writes WHERE id = ?`, id); err != nil {
			return nil, err
		}
	}
	return out, tx.Commit()
}

// SetBinding records an (cwd_pattern, agent_kind) -> space_id mapping.
func (c *Cache) SetBinding(cwd, kind string, spaceID uuid.UUID, confirmed bool) error {
	_, err := c.db.Exec(
		`INSERT OR REPLACE INTO agent_bindings(cwd_pattern, agent_kind, space_id, confirmed)
		 VALUES (?, ?, ?, ?)`,
		cwd, kind, spaceID.String(), confirmed,
	)
	return err
}

// GetBinding returns the recorded space for (cwd, kind), or sql.ErrNoRows.
func (c *Cache) GetBinding(cwd, kind string) (uuid.UUID, error) {
	var spaceStr string
	err := c.db.QueryRow(
		`SELECT space_id FROM agent_bindings
		 WHERE cwd_pattern = ? AND agent_kind = ?`,
		cwd, kind,
	).Scan(&spaceStr)
	if errors.Is(err, sql.ErrNoRows) {
		return uuid.Nil, sql.ErrNoRows
	}
	if err != nil {
		return uuid.Nil, err
	}
	return uuid.MustParse(spaceStr), nil
}
