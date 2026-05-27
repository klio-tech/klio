package project

import (
	"container/list"
	"context"
	"sync"
)

// Cache wraps Resolve with an LRU keyed by abspath(cwd).
// Concurrency-safe via a single mutex.
//
// Why a coarse mutex: the miss path shells out to git (~25ms on macOS).
// A finer-grained scheme (read/write locks, per-key locks) buys nothing
// because cache HITS are <1us — the mutex contention is invisible. Hits
// dominate by orders of magnitude in the steady state (a typical session
// fires ~200 hooks against a handful of distinct cwds).
//
// What we do NOT invalidate: if the user changes `remote.origin.url`
// mid-session, the cache returns the stale GitRemote until the bridge
// restarts. Acceptable — git config changes are rare, and a bridge
// restart flushes everything. Document it; don't engineer around it.
//
// Keying: the raw cwd string the caller passed. We don't filepath.Abs
// here because Resolve itself normalises to abs in the miss path, and
// callers in practice pass a stable cwd (the hook's working directory).
// Keying on the un-normalised string keeps Cache itself a pure wrapper
// — all path semantics live in Resolve.
type Cache struct {
	mu       sync.Mutex
	cap      int
	evict    *list.List // front = MRU, back = LRU
	items    map[string]*list.Element
	resolver func(context.Context, string) (Key, error)
}

// cacheEntry is what we store in each list element. We keep cwd alongside
// key because list eviction gives us the *list.Element, and we need the
// cwd to delete the matching entry from the items map.
type cacheEntry struct {
	cwd string
	key Key
}

// defaultCapacity is the fallback when callers pass capacity <= 0.
// 128 comfortably covers the cwd-diversity of any realistic session
// (a single dev machine rarely sees more than a few dozen distinct
// repos in active rotation).
const defaultCapacity = 128

// NewCache returns a cache with the production Resolve as the
// underlying resolver. Capacity <= 0 falls back to defaultCapacity.
func NewCache(capacity int) *Cache {
	return newCacheWithResolver(capacity, Resolve)
}

// newCacheWithResolver is the test seam — lets tests inject a stub
// resolver that counts calls without shelling out to git. Unexported
// because production callers should always go through NewCache and
// inherit the real Resolve.
func newCacheWithResolver(
	capacity int,
	resolver func(context.Context, string) (Key, error),
) *Cache {
	if capacity <= 0 {
		capacity = defaultCapacity
	}
	return &Cache{
		cap:      capacity,
		evict:    list.New(),
		items:    make(map[string]*list.Element, capacity),
		resolver: resolver,
	}
}

// Resolve returns the cached Key for cwd, or shells out to the
// underlying resolver on miss. Hits move the entry to the front (MRU);
// misses insert at the front and evict the back (LRU) when over capacity.
//
// On resolver error the entry is NOT cached — a transient failure
// (e.g. context cancellation) should be retryable on the next call.
func (c *Cache) Resolve(ctx context.Context, cwd string) (Key, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if elem, ok := c.items[cwd]; ok {
		c.evict.MoveToFront(elem)
		// elem.Value is `any`; the cast is safe because we only ever
		// push *cacheEntry values onto the list. A panic here would
		// indicate a programming error in this file, not bad input.
		return elem.Value.(*cacheEntry).key, nil
	}

	key, err := c.resolver(ctx, cwd)
	if err != nil {
		return Key{}, err
	}

	entry := &cacheEntry{cwd: cwd, key: key}
	elem := c.evict.PushFront(entry)
	c.items[cwd] = elem

	if c.evict.Len() > c.cap {
		// `oldest != nil` is unreachable when cap >= 1 (we just PushFront'd,
		// so Len() > cap implies at least 2 elements, so Back() is non-nil).
		// The constructor clamps capacity to defaultCapacity for cap <= 0
		// inputs, so cap >= 1 is guaranteed. Kept as belt-and-suspenders: a
		// future change to either the constructor's clamp OR the eviction
		// trigger would otherwise risk a nil-deref panic on a hot path.
		if oldest := c.evict.Back(); oldest != nil {
			c.evict.Remove(oldest)
			delete(c.items, oldest.Value.(*cacheEntry).cwd)
		}
	}

	return key, nil
}
