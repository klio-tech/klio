// Package daemon wires config, cache, cloud client, and the socket+MCP layer
// into a single runnable process.
package daemon

import (
	"context"
	"errors"
	"log/slog"
	"sync"

	"github.com/google/uuid"

	"github.com/klio-tech/bridge/internal/cache"
	"github.com/klio-tech/bridge/internal/cloud"
	"github.com/klio-tech/bridge/internal/config"
	"github.com/klio-tech/bridge/internal/keychain"
	"github.com/klio-tech/bridge/internal/mcp"
	"github.com/klio-tech/bridge/internal/realtime"
	"github.com/klio-tech/bridge/internal/socket"
)

// Daemon is the long-lived process that listens on a unix socket and proxies
// MCP traffic through to the cloud.
type Daemon struct {
	cfg        *config.Config
	cache      *cache.Cache
	cloud      *cloud.Client
	keys       keychain.Backend
	server     *socket.Server
	mcp        *mcp.Dispatcher
	subscriber *realtime.Subscriber // optional; nil if Redis URL is unset

	mu            sync.RWMutex
	activeSpaceID *uuid.UUID
	subscribed    map[uuid.UUID]struct{}

	// frameHandler is called for every realtime frame received. Tests
	// override it to inspect dispatch behavior.
	frameHandler func(realtime.Frame)
}

// New constructs a Daemon. It does NOT start the listener — call Run.
func New(cfg *config.Config, keys keychain.Backend) (*Daemon, error) {
	c, err := cache.Open(cfg.CacheDBPath)
	if err != nil {
		return nil, err
	}
	cl := cloud.NewClientWithPinning(cfg.CloudURL, cfg.PinnedCertSHA256)

	d := &Daemon{
		cfg:        cfg,
		cache:      c,
		cloud:      cl,
		keys:       keys,
		subscribed: map[uuid.UUID]struct{}{},
	}
	d.frameHandler = d.defaultFrameHandler
	d.mcp = mcp.NewDispatcher(d)
	d.server = socket.New(cfg.SocketPath, d.handle)

	if rt, err := keys.Get("refresh_token"); err == nil {
		cl.SetRefreshToken(string(rt))
	}
	if at, err := keys.Get("access_token"); err == nil {
		cl.SetAccessToken(string(at))
	}

	if cfg.RedisURL != "" && !cfg.LocalOnly {
		sub, err := realtime.NewSubscriber(cfg.RedisURL)
		if err != nil {
			slog.Warn("realtime subscriber init failed; continuing without realtime",
				"err", err)
		} else {
			d.subscriber = sub
		}
	}

	return d, nil
}

// Run starts the daemon and blocks until ctx is canceled.
func (d *Daemon) Run(ctx context.Context) error {
	defer d.cache.Close()
	if d.subscriber != nil {
		defer func() { _ = d.subscriber.Close() }()
		// Subscribe to all spaces the user has access to. Best-effort —
		// if cloud is unreachable on startup, we'll subscribe lazily on
		// the next successful ListSpaces.
		go d.subscribeAccessibleSpaces(ctx)
	}
	return d.server.Run(ctx)
}

// subscribeAccessibleSpaces lists user's spaces from cloud and starts a
// per-space subscription. Refreshes every 5 minutes.
func (d *Daemon) subscribeAccessibleSpaces(ctx context.Context) {
	d.refreshSubscriptions(ctx)
	t := newTicker(5 * 60)
	defer t.stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.tick():
			d.refreshSubscriptions(ctx)
		}
	}
}

func (d *Daemon) refreshSubscriptions(ctx context.Context) {
	if d.subscriber == nil {
		return
	}
	spaces, err := d.cloud.ListSpaces(ctx)
	if err != nil {
		slog.Debug("refreshSubscriptions: ListSpaces failed", "err", err)
		return
	}
	wantedIDs := map[uuid.UUID]struct{}{}
	for _, s := range spaces {
		wantedIDs[s.ID] = struct{}{}
	}

	d.mu.Lock()
	for id := range wantedIDs {
		if _, already := d.subscribed[id]; already {
			continue
		}
		spaceID := id
		// Use a closure that dispatches through the *current* d.frameHandler
		// at frame-arrival time. This lets tests (and future runtime
		// reconfiguration) change the handler after subscription.
		dispatch := func(f realtime.Frame) {
			d.mu.RLock()
			h := d.frameHandler
			d.mu.RUnlock()
			if h != nil {
				h(f)
			}
		}
		if err := d.subscriber.Subscribe(ctx, spaceID, dispatch); err != nil {
			slog.Warn("Subscribe failed", "space_id", spaceID, "err", err)
			continue
		}
		d.subscribed[spaceID] = struct{}{}
		slog.Debug("subscribed to space", "space_id", spaceID)
	}
	for id := range d.subscribed {
		if _, ok := wantedIDs[id]; !ok {
			d.subscriber.Unsubscribe(id)
			delete(d.subscribed, id)
			slog.Debug("unsubscribed from space", "space_id", id)
		}
	}
	d.mu.Unlock()
}

// defaultFrameHandler is called for each frame received from realtime.
// It writes the entry to local cache and (in a future revision) emits
// MCP notifications/resources/updated to connected shims.
func (d *Daemon) defaultFrameHandler(f realtime.Frame) {
	switch f.Type {
	case "entry.created":
		// Best-effort cache mirror so subsequent recall hits can find it.
		if f.Entry == nil {
			return
		}
		entryIDStr, _ := f.Entry["id"].(string)
		spaceIDStr, _ := f.Entry["space_id"].(string)
		kind, _ := f.Entry["kind"].(string)
		content, _ := f.Entry["content"].(string)
		entryID, err := uuid.Parse(entryIDStr)
		if err != nil {
			return
		}
		spaceID, err := uuid.Parse(spaceIDStr)
		if err != nil {
			return
		}
		_ = d.cache.PutEntry(cache.CachedEntry{
			ID:      entryID,
			SpaceID: spaceID,
			Kind:    kind,
			Content: content,
		})
		slog.Info("realtime: entry.created", "id", entryID, "space", spaceID, "kind", kind)
	case "entry.superseded", "entry.deleted", "permission.changed":
		slog.Info("realtime: frame received", "type", f.Type, "space", f.SpaceID)
	}
}

// Cache returns the daemon's local cache (used by tests, hooks).
func (d *Daemon) Cache() *cache.Cache { return d.cache }

// Cloud returns the daemon's HTTP client.
func (d *Daemon) Cloud() *cloud.Client { return d.cloud }

// Keys returns the daemon's keychain backend.
func (d *Daemon) Keys() keychain.Backend { return d.keys }

// SetActiveSpace records the active space id for backend queries.
func (d *Daemon) SetActiveSpace(id uuid.UUID) {
	d.mu.Lock()
	d.activeSpaceID = &id
	d.mu.Unlock()
}

// ActiveSpace returns the currently-bound space id, if any.
func (d *Daemon) ActiveSpace() (uuid.UUID, bool) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	if d.activeSpaceID == nil {
		return uuid.Nil, false
	}
	return *d.activeSpaceID, true
}

// SubscribedSpaces returns a snapshot of currently-subscribed space ids.
// Used by tests to assert the lifecycle.
func (d *Daemon) SubscribedSpaces() []uuid.UUID {
	d.mu.RLock()
	defer d.mu.RUnlock()
	out := make([]uuid.UUID, 0, len(d.subscribed))
	for id := range d.subscribed {
		out = append(out, id)
	}
	return out
}

// SetFrameHandler overrides the realtime frame handler. Used by tests
// and (later) by runtime reconfiguration. Safe to call before or after Run.
func (d *Daemon) SetFrameHandler(h func(realtime.Frame)) {
	d.mu.Lock()
	d.frameHandler = h
	d.mu.Unlock()
}

func (d *Daemon) handle(line []byte) []byte {
	return d.mcp.Handle(line)
}

// resolveSpace returns the space id for `slug` (or active space if slug is empty).
// On lookup failure returns ErrSpaceNotFound.
var ErrSpaceNotFound = errors.New("space not found")

func (d *Daemon) resolveSpace(ctx context.Context, slug string) (uuid.UUID, error) {
	if slug == "" {
		if id, ok := d.ActiveSpace(); ok {
			return id, nil
		}
		slug = "default"
	}
	spaces, err := d.cloud.ListSpaces(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	for _, s := range spaces {
		if s.Slug == slug {
			return s.ID, nil
		}
	}
	return uuid.Nil, ErrSpaceNotFound
}
