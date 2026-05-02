// Package bootstrap implements `klio init` — provisions an anonymous
// account on behalf of the user (idempotently — re-running re-uses an
// existing account if credentials are present), persists credentials,
// and patches every detected agent's config.
package bootstrap

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/google/uuid"

	"github.com/klio-tech/bridge/internal/agentadapters"
	"github.com/klio-tech/bridge/internal/cloud"
	"github.com/klio-tech/bridge/internal/keychain"
)

// Options configures Run.
type Options struct {
	CloudURL string

	// KlioBinary is the absolute path to the running `klio` binary.
	// Used to write absolute hook commands so Claude Code can spawn
	// them without relying on PATH.
	KlioBinary string

	// KlioMcpBinary is the absolute path to the `klio-mcp` binary.
	KlioMcpBinary string

	// Env is the environment block applied to MCP server + hooks. The
	// caller is responsible for assembling it (the daemon's settings
	// — KLIO_SOCKET_PATH, optionally KLIO_USE_FILE_KEYCHAIN — should
	// be included).
	Env map[string]string

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
	// Reused is true when Run found existing credentials in the keychain
	// and skipped account provisioning. The agent configs are still
	// patched so a stale `klio init` run can be repaired in place.
	Reused bool
}

// Run is the full klio init flow. Returns a Report describing what changed.
//
// Idempotent: if credentials exist in the keychain, Run skips
// provisioning and re-uses the saved (user_id, agent_id, default_space_id).
// This means re-running `klio init` after fixing a settings.json bug
// does NOT create a new account.
func Run(ctx context.Context, opts Options) (*Report, error) {
	if opts.CloudURL == "" {
		opts.CloudURL = "https://api.klio.tech"
	}
	if opts.KlioBinary == "" {
		return nil, errors.New("Options.KlioBinary is required (absolute path)")
	}
	if opts.KlioMcpBinary == "" {
		return nil, errors.New("Options.KlioMcpBinary is required (absolute path)")
	}
	if opts.Keychain == nil {
		return nil, errors.New("Keychain backend is required")
	}

	// Check for existing creds first. If found, we re-use them rather
	// than minting a new account every install.
	report := &Report{}
	if existing, ok := loadExistingCreds(opts.Keychain); ok {
		report.UserID = existing.userID
		report.AgentID = existing.agentID
		report.DefaultSpaceID = existing.defaultSpaceID
		report.APIKey = existing.refreshToken
		report.Reused = true
	} else {
		c := cloud.NewClient(opts.CloudURL)
		installID := getOrCreateInstallID(opts.Keychain)
		prov, err := c.Provision(ctx, cloud.ProvisionRequest{
			AgentKind: "klio-bridge",
			InstallID: installID,
			Email:     opts.Email,
		})
		if err != nil {
			return nil, fmt.Errorf("provision failed: %w", err)
		}
		if err := persistCreds(opts.Keychain, prov); err != nil {
			return nil, err
		}
		report.UserID = prov.UserID
		report.AgentID = prov.AgentID
		report.DefaultSpaceID = prov.DefaultSpaceID
		report.APIKey = prov.APIKey
	}

	// Ensure ~/.klio exists.
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(home, ".klio"), 0o700); err != nil {
		return nil, err
	}

	// Patch each detected agent (always — this is how we repair stale
	// configs on re-init).
	cfg := agentadapters.Config{
		KlioBinary:    opts.KlioBinary,
		KlioMcpBinary: opts.KlioMcpBinary,
		Env:           opts.Env,
	}
	adapters := opts.Adapters
	if adapters == nil {
		adapters = agentadapters.All()
	}
	for _, adapter := range adapters {
		if !adapter.Installed() {
			continue
		}
		if err := adapter.Install(cfg); err != nil {
			report.AgentsErrored = append(
				report.AgentsErrored,
				fmt.Sprintf("%s: %s", adapter.Name(), err),
			)
			continue
		}
		report.AgentsConfigured = append(report.AgentsConfigured, adapter.Name())
	}

	return report, nil
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

type savedCreds struct {
	refreshToken   string
	userID         uuid.UUID
	agentID        uuid.UUID
	defaultSpaceID uuid.UUID
}

// loadExistingCreds returns saved credentials if all four fields are
// present and parseable; otherwise (false). Partial state is treated
// as "not present" so a corrupted keychain triggers a fresh provision.
func loadExistingCreds(kc keychain.Backend) (savedCreds, bool) {
	rt, err := kc.Get("refresh_token")
	if err != nil || len(rt) == 0 {
		return savedCreds{}, false
	}
	uidRaw, err := kc.Get("user_id")
	if err != nil || len(uidRaw) == 0 {
		return savedCreds{}, false
	}
	aidRaw, err := kc.Get("agent_id")
	if err != nil || len(aidRaw) == 0 {
		return savedCreds{}, false
	}
	sidRaw, err := kc.Get("default_space_id")
	if err != nil || len(sidRaw) == 0 {
		return savedCreds{}, false
	}
	uid, err := uuid.Parse(string(uidRaw))
	if err != nil {
		return savedCreds{}, false
	}
	aid, err := uuid.Parse(string(aidRaw))
	if err != nil {
		return savedCreds{}, false
	}
	sid, err := uuid.Parse(string(sidRaw))
	if err != nil {
		return savedCreds{}, false
	}
	return savedCreds{
		refreshToken:   string(rt),
		userID:         uid,
		agentID:        aid,
		defaultSpaceID: sid,
	}, true
}

func persistCreds(kc keychain.Backend, prov *cloud.ProvisionResponse) error {
	if err := kc.Set("refresh_token", []byte(prov.APIKey)); err != nil {
		return fmt.Errorf("keychain set refresh_token: %w", err)
	}
	if err := kc.Set("user_id", []byte(prov.UserID.String())); err != nil {
		return err
	}
	if err := kc.Set("agent_id", []byte(prov.AgentID.String())); err != nil {
		return err
	}
	if err := kc.Set("default_space_id", []byte(prov.DefaultSpaceID.String())); err != nil {
		return err
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
