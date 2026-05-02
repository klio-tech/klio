// Package bootstrap implements `klio init` — provisions an anonymous
// account on behalf of the user, persists credentials, and patches every
// detected agent's config.
package bootstrap

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/google/uuid"

	"github.com/klio-tech/bridge/internal/agentadapters"
	"github.com/klio-tech/bridge/internal/cloud"
	"github.com/klio-tech/bridge/internal/keychain"
)

// Options configures Run.
type Options struct {
	CloudURL       string
	KlioMcpBinary  string
	Keychain       keychain.Backend
	Email          string
	Adapters       []agentadapters.Adapter // override for tests; default is agentadapters.All()
	ProvisionExtra map[string]any          // for forward compat
}

// Report describes what Run did.
type Report struct {
	UserID           uuid.UUID
	AgentID          uuid.UUID
	DefaultSpaceID   uuid.UUID
	APIKey           string
	AgentsConfigured []string
	AgentsErrored    []string
}

// Run is the full klio init flow. Returns a Report describing what changed.
func Run(ctx context.Context, opts Options) (*Report, error) {
	if opts.CloudURL == "" {
		opts.CloudURL = "https://api.klio.tech"
	}
	if opts.KlioMcpBinary == "" {
		opts.KlioMcpBinary = "klio-mcp"
	}
	if opts.Keychain == nil {
		return nil, errors.New("Keychain backend is required")
	}

	c := cloud.NewClient(opts.CloudURL)
	installID := getOrCreateInstallID(opts.Keychain)
	provReq := cloud.ProvisionRequest{
		AgentKind: "klio-bridge",
		InstallID: installID,
		Email:     opts.Email,
	}
	prov, err := c.Provision(ctx, provReq)
	if err != nil {
		return nil, fmt.Errorf("provision failed: %w", err)
	}

	// Persist credentials
	if err := opts.Keychain.Set("refresh_token", []byte(prov.APIKey)); err != nil {
		return nil, fmt.Errorf("keychain set refresh_token: %w", err)
	}
	if err := opts.Keychain.Set("user_id", []byte(prov.UserID.String())); err != nil {
		return nil, err
	}
	if err := opts.Keychain.Set("agent_id", []byte(prov.AgentID.String())); err != nil {
		return nil, err
	}
	if err := opts.Keychain.Set("default_space_id", []byte(prov.DefaultSpaceID.String())); err != nil {
		return nil, err
	}

	// Ensure ~/.klio exists
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(home+"/.klio", 0o700); err != nil {
		return nil, err
	}

	// Patch each detected agent
	adapters := opts.Adapters
	if adapters == nil {
		adapters = agentadapters.All()
	}
	configured := []string{}
	errored := []string{}
	for _, adapter := range adapters {
		if !adapter.Installed() {
			continue
		}
		if err := adapter.Install(opts.KlioMcpBinary); err != nil {
			errored = append(errored, fmt.Sprintf("%s: %s", adapter.Name(), err))
			continue
		}
		configured = append(configured, adapter.Name())
	}

	return &Report{
		UserID:           prov.UserID,
		AgentID:          prov.AgentID,
		DefaultSpaceID:   prov.DefaultSpaceID,
		APIKey:           prov.APIKey,
		AgentsConfigured: configured,
		AgentsErrored:    errored,
	}, nil
}

// Uninstall reverses Run: restores agent configs from backups and clears
// credentials from the keychain. Cloud account is NOT deleted unless
// purgeCloud is set (which would call DELETE /v1/users/{id}).
func Uninstall(_ context.Context, kc keychain.Backend) error {
	for _, adapter := range agentadapters.All() {
		if !adapter.Installed() {
			continue
		}
		_ = adapter.Uninstall()
	}
	for _, k := range []string{"refresh_token", "access_token", "user_id", "agent_id", "default_space_id", "install_id"} {
		_ = kc.Delete(k)
	}
	return nil
}

func getOrCreateInstallID(kc keychain.Backend) uuid.UUID {
	if existing, err := kc.Get("install_id"); err == nil && len(existing) > 0 {
		if id, err := uuid.Parse(string(existing)); err == nil {
			return id
		}
	}
	id := uuid.New()
	_ = kc.Set("install_id", []byte(id.String()))
	return id
}
