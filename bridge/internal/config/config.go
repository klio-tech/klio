// Package config loads bridge daemon configuration from defaults, ~/.klio/config.json, and env.
//
// Precedence (highest wins): env > config file > defaults.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
)

// Config is the bridge daemon's runtime configuration.
type Config struct {
	SocketPath     string `json:"socket_path"`
	CloudURL       string `json:"cloud_url"`
	LocalOnly      bool   `json:"local_only"`
	CacheDBPath    string `json:"cache_db_path"`
	UpdatesURL     string `json:"updates_url"`
	LogLevel       string `json:"log_level"`
	TelemetryOptIn bool   `json:"telemetry_opt_in"`
}

// Load returns the bridge config, applying defaults, file overrides, then env overrides.
func Load() (*Config, error) {
	c := defaults()
	if err := applyFile(c); err != nil {
		return nil, err
	}
	applyEnv(c)
	return c, nil
}

// EnsureKlioDir makes sure ~/.klio exists with 0700.
func EnsureKlioDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".klio")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("ensure %s: %w", dir, err)
	}
	return dir, nil
}

func defaults() *Config {
	home, _ := os.UserHomeDir()
	socket := filepath.Join(home, ".klio", "bridge.sock")
	if runtime.GOOS == "windows" {
		socket = "127.0.0.1:7878"
	}
	return &Config{
		SocketPath:  socket,
		CloudURL:    "https://api.klio.tech",
		LocalOnly:   false,
		CacheDBPath: filepath.Join(home, ".klio", "cache.db"),
		UpdatesURL:  "https://updates.klio.tech/manifest.json",
		LogLevel:    "info",
	}
}

func applyFile(c *Config) error {
	home, _ := os.UserHomeDir()
	path := filepath.Join(home, ".klio", "config.json")
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(data, c)
}

func applyEnv(c *Config) {
	if v := os.Getenv("KLIO_API_URL"); v != "" {
		c.CloudURL = v
	}
	if v := os.Getenv("KLIO_LOCAL_ONLY"); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			c.LocalOnly = b
		}
	}
	if v := os.Getenv("KLIO_LOG_LEVEL"); v != "" {
		c.LogLevel = v
	}
	if v := os.Getenv("KLIO_SOCKET_PATH"); v != "" {
		c.SocketPath = v
	}
	if v := os.Getenv("KLIO_CACHE_DB_PATH"); v != "" {
		c.CacheDBPath = v
	}
}
