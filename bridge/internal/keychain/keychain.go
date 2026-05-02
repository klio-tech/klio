// Package keychain wraps platform-native credential storage.
//
//   - macOS: Keychain Services (via go-keyring)
//   - Linux: Secret Service / libsecret (via go-keyring's D-Bus binding)
//   - Windows: Credential Manager (via go-keyring)
//
// On systems without a working secret service (e.g., CI containers), callers
// can construct a FileBackend instead — it stores values in an
// AES-256-GCM-encrypted file under a caller-provided master key.
package keychain

import (
	"errors"

	"github.com/zalando/go-keyring"
)

// ErrNotFound indicates the requested key is not stored.
var ErrNotFound = errors.New("keychain: key not found")

// Backend is the contract every storage option satisfies.
type Backend interface {
	Set(key string, value []byte) error
	Get(key string) ([]byte, error)
	Delete(key string) error
}

// Keychain stores secrets via the OS keyring under a stable service id.
type Keychain struct {
	service string
}

// New returns a Keychain bound to a service identifier (reverse-DNS).
func New(service string) *Keychain {
	return &Keychain{service: service}
}

// Set stores or overwrites the secret.
func (k *Keychain) Set(key string, value []byte) error {
	return keyring.Set(k.service, key, string(value))
}

// Get fetches the secret. Returns ErrNotFound if absent.
func (k *Keychain) Get(key string) ([]byte, error) {
	v, err := keyring.Get(k.service, key)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return []byte(v), nil
}

// Delete removes the secret. Idempotent.
func (k *Keychain) Delete(key string) error {
	err := keyring.Delete(k.service, key)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}
