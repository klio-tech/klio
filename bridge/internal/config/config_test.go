package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("KLIO_API_URL", "")
	t.Setenv("KLIO_LOCAL_ONLY", "")
	t.Setenv("KLIO_SOCKET_PATH", "")

	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.CloudURL != "https://api.klio.tech" {
		t.Fatalf("default cloud_url: %s", c.CloudURL)
	}
	if c.LocalOnly {
		t.Fatal("default LocalOnly must be false")
	}
}

func TestEnvOverrides(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("KLIO_API_URL", "http://localhost:9999")
	t.Setenv("KLIO_LOCAL_ONLY", "true")

	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.CloudURL != "http://localhost:9999" {
		t.Fatalf("env override failed: %s", c.CloudURL)
	}
	if !c.LocalOnly {
		t.Fatal("LOCAL_ONLY env not honored")
	}
}

func TestFileLoaded(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("KLIO_API_URL", "")

	klioDir := filepath.Join(tmp, ".klio")
	_ = os.MkdirAll(klioDir, 0o755)
	_ = os.WriteFile(
		filepath.Join(klioDir, "config.json"),
		[]byte(`{"cloud_url":"https://staging.klio.tech"}`),
		0o600,
	)

	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.CloudURL != "https://staging.klio.tech" {
		t.Fatalf("file value not loaded: %s", c.CloudURL)
	}
}
