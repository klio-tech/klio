// Package daemon wires config, cache, cloud client, and the socket+MCP layer
// into a single runnable process.
package daemon

import (
	"context"
	"errors"
	"sync"

	"github.com/google/uuid"

	"github.com/klio-tech/bridge/internal/cache"
	"github.com/klio-tech/bridge/internal/cloud"
	"github.com/klio-tech/bridge/internal/config"
	"github.com/klio-tech/bridge/internal/keychain"
	"github.com/klio-tech/bridge/internal/mcp"
	"github.com/klio-tech/bridge/internal/socket"
)

// Daemon is the long-lived process that listens on a unix socket and proxies
// MCP traffic through to the cloud.
type Daemon struct {
	cfg      *config.Config
	cache    *cache.Cache
	cloud    *cloud.Client
	keys     keychain.Backend
	server   *socket.Server
	mcp      *mcp.Dispatcher

	mu            sync.RWMutex
	activeSpaceID *uuid.UUID
}

// New constructs a Daemon. It does NOT start the listener — call Run.
func New(cfg *config.Config, keys keychain.Backend) (*Daemon, error) {
	c, err := cache.Open(cfg.CacheDBPath)
	if err != nil {
		return nil, err
	}
	cl := cloud.NewClient(cfg.CloudURL)

	d := &Daemon{cfg: cfg, cache: c, cloud: cl, keys: keys}
	d.mcp = mcp.NewDispatcher(d)
	d.server = socket.New(cfg.SocketPath, d.handle)

	// Restore credentials if present
	if rt, err := keys.Get("refresh_token"); err == nil {
		cl.SetRefreshToken(string(rt))
	}
	if at, err := keys.Get("access_token"); err == nil {
		cl.SetAccessToken(string(at))
	}

	return d, nil
}

// Run starts the daemon and blocks until ctx is canceled.
func (d *Daemon) Run(ctx context.Context) error {
	defer d.cache.Close()
	return d.server.Run(ctx)
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
