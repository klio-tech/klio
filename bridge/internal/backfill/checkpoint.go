package backfill

import (
	"encoding/json"
	"os"
	"sync"
)

// Checkpoint persists which sessions have been processed so backfill is
// resumable.
type Checkpoint struct {
	path string
	mu   sync.Mutex
	done map[string]bool
}

// NewCheckpoint returns a Checkpoint at path. Empty path => in-memory only.
func NewCheckpoint(path string) *Checkpoint {
	cp := &Checkpoint{path: path, done: map[string]bool{}}
	cp.load()
	return cp
}

func (c *Checkpoint) load() {
	if c.path == "" {
		return
	}
	data, err := os.ReadFile(c.path)
	if err != nil {
		return
	}
	_ = json.Unmarshal(data, &c.done)
	if c.done == nil {
		c.done = map[string]bool{}
	}
}

// IsDone reports whether sessionID has already been processed.
func (c *Checkpoint) IsDone(sessionID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.done[sessionID]
}

// MarkDone records a session as completed and persists immediately.
func (c *Checkpoint) MarkDone(sessionID string) error {
	c.mu.Lock()
	c.done[sessionID] = true
	body, _ := json.Marshal(c.done)
	c.mu.Unlock()
	if c.path == "" {
		return nil
	}
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, c.path)
}
