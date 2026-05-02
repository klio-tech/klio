package keychain

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestFileBackendRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "creds.enc")
	masterKey := make([]byte, 32)
	for i := range masterKey {
		masterKey[i] = byte(i)
	}

	b := NewFileBackend(path, masterKey)
	if err := b.Set("k1", []byte("v1")); err != nil {
		t.Fatalf("Set: %v", err)
	}
	got, err := b.Get("k1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if string(got) != "v1" {
		t.Fatalf("got %q", got)
	}
}

func TestFileBackendPersistsAcrossInstances(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "creds.enc")
	masterKey := make([]byte, 32)
	for i := range masterKey {
		masterKey[i] = byte(i + 1)
	}

	b1 := NewFileBackend(path, masterKey)
	_ = b1.Set("persistent", []byte("yes"))

	b2 := NewFileBackend(path, masterKey)
	got, err := b2.Get("persistent")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if string(got) != "yes" {
		t.Fatalf("got %q", got)
	}
}

func TestFileBackendWrongKeyFails(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "creds.enc")
	keyA := make([]byte, 32)
	keyB := make([]byte, 32)
	for i := range keyB {
		keyB[i] = 1
	}

	bA := NewFileBackend(path, keyA)
	_ = bA.Set("k", []byte("v"))

	bB := NewFileBackend(path, keyB)
	_, err := bB.Get("k")
	if err == nil {
		t.Fatal("expected error with wrong master key")
	}
}

func TestFileBackendDelete(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "creds.enc")
	masterKey := make([]byte, 32)
	b := NewFileBackend(path, masterKey)
	_ = b.Set("doomed", []byte("x"))
	_ = b.Delete("doomed")
	_, err := b.Get("doomed")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}
