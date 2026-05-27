package project

import (
	"context"
	"fmt"
	"sync"
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

// TestCacheHitPromotesEntry proves that a HIT on an entry moves it to
// MRU position — so a subsequent insert that overflows the cache
// evicts the *other* entry, not the recently-hit one. Without this
// test, a regression that drops the MoveToFront(elem) call on hit
// would silently pass TestCacheEvictsLeastRecent.
func TestCacheHitPromotesEntry(t *testing.T) {
	var calls int32
	resolver := func(_ context.Context, cwd string) (Key, error) {
		atomic.AddInt32(&calls, 1)
		return Key{AbsCwd: cwd}, nil
	}
	c := newCacheWithResolver(2, resolver)
	ctx := context.Background()

	_, _ = c.Resolve(ctx, "/a") // miss → calls=1, evict=[a]
	_, _ = c.Resolve(ctx, "/b") // miss → calls=2, evict=[b, a]
	_, _ = c.Resolve(ctx, "/a") // HIT → calls stays 2; moves a to MRU; evict=[a, b]
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("after re-resolving /a (expected hit), got %d underlying calls, want 2", got)
	}
	_, _ = c.Resolve(ctx, "/c") // miss → calls=3, evict b (LRU), evict=[c, a]

	callsBefore := atomic.LoadInt32(&calls)
	_, _ = c.Resolve(ctx, "/a") // must be HIT (a was promoted, /b was evicted instead)
	if got := atomic.LoadInt32(&calls); got != callsBefore {
		t.Errorf(
			"after evicting overflow with /c, /a should still be cached "+
				"(was promoted on prior hit); got %d underlying calls, want %d (no new miss)",
			got, callsBefore,
		)
	}
	// And /b should now be a miss (it was the LRU when /c arrived).
	callsBefore = atomic.LoadInt32(&calls)
	_, _ = c.Resolve(ctx, "/b")
	if got := atomic.LoadInt32(&calls); got != callsBefore+1 {
		t.Errorf("/b should have been evicted by /c; expected miss, got %d (want %d)",
			got, callsBefore+1)
	}
}

// TestCacheConcurrentAccess hammers the cache from 50 goroutines
// against 5 cwds simultaneously. Run with `-race` to catch any
// concurrency regression (e.g., a future RWMutex refactor that gets
// the upgrade-during-read wrong). The package's coarse-mutex design
// makes this test cheap to satisfy today.
//
// The test asserts no panics, no races, and that the cache size stays
// bounded by the capacity — the latter is the load-bearing invariant
// the LRU's map-and-list lockstep must maintain under contention.
func TestCacheConcurrentAccess(t *testing.T) {
	var calls int32
	resolver := func(_ context.Context, cwd string) (Key, error) {
		atomic.AddInt32(&calls, 1)
		return Key{AbsCwd: cwd}, nil
	}
	c := newCacheWithResolver(8, resolver)
	ctx := context.Background()

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				_, err := c.Resolve(ctx, fmt.Sprintf("/cwd/%d", i%5))
				if err != nil {
					t.Errorf("Resolve: %v", err)
					return
				}
			}
		}(i)
	}
	wg.Wait()
}
