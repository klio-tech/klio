package agentadapters

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// readJSON loads a JSON file as a map[string]any. Empty/missing files return
// an empty map. Malformed JSON returns an error.
func readJSON(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return map[string]any{}, nil
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("config at %s is not valid JSON: %w", path, err)
	}
	return out, nil
}

func writeJSON(path string, data map[string]any) error {
	body, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, body, 0o644)
}

func backupFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	backup := fmt.Sprintf("%s.klio-backup-%d", path, time.Now().Unix())
	return os.WriteFile(backup, data, 0o644)
}

func restoreFromBackup(path string) error {
	dir := filepath.Dir(path)
	base := filepath.Base(path)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	prefix := base + ".klio-backup-"
	var latest string
	var latestTime int64
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		var ts int64
		_, _ = fmt.Sscanf(name[len(prefix):], "%d", &ts)
		if ts > latestTime {
			latest = name
			latestTime = ts
		}
	}
	if latest == "" {
		return fmt.Errorf("no Klio backup found for %s", path)
	}
	data, err := os.ReadFile(filepath.Join(dir, latest))
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}
