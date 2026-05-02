package keychain

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sync"
)

// FileBackend stores key/value pairs in a single AES-256-GCM-encrypted file.
// Master key must be 32 bytes. Used as a fallback when the OS keychain is
// unavailable (headless containers, some Linux setups, tests).
type FileBackend struct {
	path      string
	masterKey []byte
	mu        sync.Mutex
}

// NewFileBackend returns a FileBackend at path, encrypting with masterKey (32 bytes).
func NewFileBackend(path string, masterKey []byte) *FileBackend {
	return &FileBackend{path: path, masterKey: masterKey}
}

// Set persists value under key.
func (f *FileBackend) Set(key string, value []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	store, err := f.load()
	if err != nil {
		return err
	}
	store[key] = string(value)
	return f.save(store)
}

// Get fetches value under key, or ErrNotFound.
func (f *FileBackend) Get(key string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	store, err := f.load()
	if err != nil {
		return nil, err
	}
	v, ok := store[key]
	if !ok {
		return nil, ErrNotFound
	}
	return []byte(v), nil
}

// Delete removes the key (idempotent).
func (f *FileBackend) Delete(key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	store, err := f.load()
	if err != nil {
		return err
	}
	delete(store, key)
	return f.save(store)
}

func (f *FileBackend) load() (map[string]string, error) {
	data, err := os.ReadFile(f.path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	if len(data) < 12 {
		return nil, errors.New("keychain file too short")
	}
	nonce, ciphertext := data[:12], data[12:]

	block, err := aes.NewCipher(f.masterKey)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, err
	}
	var store map[string]string
	if err := json.Unmarshal(plaintext, &store); err != nil {
		return nil, err
	}
	return store, nil
}

func (f *FileBackend) save(store map[string]string) error {
	plaintext, err := json.Marshal(store)
	if err != nil {
		return err
	}
	block, err := aes.NewCipher(f.masterKey)
	if err != nil {
		return err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	nonce := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return err
	}
	ct := gcm.Seal(nil, nonce, plaintext, nil)
	return os.WriteFile(f.path, append(nonce, ct...), 0o600)
}
