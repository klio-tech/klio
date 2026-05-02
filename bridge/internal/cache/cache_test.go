package cache

import (
	"path/filepath"
	"testing"

	"github.com/google/uuid"
)

func TestPutGetRoundTrip(t *testing.T) {
	dir := t.TempDir()
	c, err := Open(filepath.Join(dir, "cache.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer c.Close()

	entryID := uuid.New()
	if err := c.PutEntry(CachedEntry{
		ID: entryID, SpaceID: uuid.New(), Kind: "memory", Content: "hello",
	}); err != nil {
		t.Fatalf("PutEntry: %v", err)
	}
	got, err := c.GetEntry(entryID)
	if err != nil {
		t.Fatalf("GetEntry: %v", err)
	}
	if got.Content != "hello" {
		t.Fatalf("got %q", got.Content)
	}
}

func TestListBySpaceFilters(t *testing.T) {
	dir := t.TempDir()
	c, _ := Open(filepath.Join(dir, "cache.db"))
	defer c.Close()

	space1 := uuid.New()
	space2 := uuid.New()
	for i, sp := range []uuid.UUID{space1, space2, space1} {
		_ = c.PutEntry(CachedEntry{
			ID: uuid.New(), SpaceID: sp, Kind: "memory", Content: "e" + string(rune('a'+i)),
		})
	}
	rows, err := c.ListBySpace(space1, 100)
	if err != nil {
		t.Fatalf("ListBySpace: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("expected 2 rows for space1, got %d", len(rows))
	}
}

func TestPendingWritesEnqueueAndDrain(t *testing.T) {
	dir := t.TempDir()
	c, _ := Open(filepath.Join(dir, "cache.db"))
	defer c.Close()

	spaceID := uuid.New()
	_ = c.EnqueuePendingWrite(spaceID, "memory", "x", nil)
	_ = c.EnqueuePendingWrite(spaceID, "note", "y", nil)

	pending, err := c.DrainPending(10)
	if err != nil {
		t.Fatalf("DrainPending: %v", err)
	}
	if len(pending) != 2 {
		t.Fatalf("expected 2 pending, got %d", len(pending))
	}
	again, _ := c.DrainPending(10)
	if len(again) != 0 {
		t.Fatalf("expected empty after drain, got %d", len(again))
	}
}

func TestBindingRoundTrip(t *testing.T) {
	dir := t.TempDir()
	c, _ := Open(filepath.Join(dir, "cache.db"))
	defer c.Close()

	spaceID := uuid.New()
	_ = c.SetBinding("/Users/x/proj", "claude-code", spaceID, true)
	got, err := c.GetBinding("/Users/x/proj", "claude-code")
	if err != nil {
		t.Fatalf("GetBinding: %v", err)
	}
	if got != spaceID {
		t.Fatalf("got %s want %s", got, spaceID)
	}
}
