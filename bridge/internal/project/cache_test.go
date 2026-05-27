package project

import (
	"context"
	"sync/atomic"
	"testing"
)

// TestCacheHitsBypassResolver verifies the hot path:
// repeated Resolve calls on the same cwd shell out to git EXACTLY ONCE.
// This is the whole point of D2 — without it, a 200-hook-fire session
// wastes ~5 seconds in `git config` forks.
func TestCacheHitsBypassResolver(t *testing.T) {
	var calls int32
	resolver := func(_ context.Context, cwd string) (Key, error) {
		atomic.AddInt32(&calls, 1)
		return Key{AbsCwd: cwd, DisplayName: "x"}, nil
	}
	c := newCacheWithResolver(8, resolver)
	ctx := context.Background()
	for i := 0; i < 10; i++ {
		if _, err := c.Resolve(ctx, "/some/cwd"); err != nil {
			t.Fatal(err)
		}
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("expected 1 underlying call, got %d", got)
	}
}

// TestCacheEvictsLeastRecent verifies LRU eviction.
// With capacity 2: insert /a, /b, /c (evicts /a). Re-resolve /a → miss.
// Total underlying calls: 4 (a, b, c, a-again).
func TestCacheEvictsLeastRecent(t *testing.T) {
	var calls int32
	resolver := func(_ context.Context, cwd string) (Key, error) {
		atomic.AddInt32(&calls, 1)
		return Key{AbsCwd: cwd}, nil
	}
	c := newCacheWithResolver(2, resolver)
	ctx := context.Background()
	_, _ = c.Resolve(ctx, "/a")
	_, _ = c.Resolve(ctx, "/b")
	_, _ = c.Resolve(ctx, "/c") // evicts /a (LRU)
	_, _ = c.Resolve(ctx, "/a") // miss; underlying called again
	if got := atomic.LoadInt32(&calls); got != 4 {
		t.Errorf("expected 4 underlying calls (a, b, c, a-again); got %d", got)
	}
}
