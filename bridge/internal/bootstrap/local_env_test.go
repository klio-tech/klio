package bootstrap

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteLocalDevEnvWritesGlobal(t *testing.T) {
	tmp := t.TempDir()
	globalPath := filepath.Join(tmp, "klio", "local-dev.env")

	paths, err := WriteLocalDevEnv(LocalDevEnvOptions{
		UserID:     "00000000-0000-0000-0000-000000000001",
		AgentID:    "00000000-0000-0000-0000-000000000002",
		GlobalPath: globalPath,
	})
	if err != nil {
		t.Fatalf("WriteLocalDevEnv: %v", err)
	}
	if len(paths) != 1 || paths[0] != globalPath {
		t.Fatalf("expected exactly the global path, got %v", paths)
	}

	body, err := os.ReadFile(globalPath)
	if err != nil {
		t.Fatalf("read %s: %v", globalPath, err)
	}
	for _, want := range []string{
		"KLIO_LOCAL_USER_ID=00000000-0000-0000-0000-000000000001",
		"KLIO_LOCAL_AGENT_ID=00000000-0000-0000-0000-000000000002",
		"KLIO_JWT_SIGNING_KEY=dev-secret",
		"do NOT commit",
	} {
		if !strings.Contains(string(body), want) {
			t.Errorf("missing %q in env file:\n%s", want, body)
		}
	}
}

func TestWriteLocalDevEnvFileMode0600(t *testing.T) {
	tmp := t.TempDir()
	globalPath := filepath.Join(tmp, "local-dev.env")
	_, err := WriteLocalDevEnv(LocalDevEnvOptions{
		UserID:     "u",
		AgentID:    "a",
		GlobalPath: globalPath,
	})
	if err != nil {
		t.Fatalf("WriteLocalDevEnv: %v", err)
	}
	info, err := os.Stat(globalPath)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("expected mode 0600, got %o", mode)
	}
}

func TestWriteLocalDevEnvOverwritesLooserPerms(t *testing.T) {
	// Simulate a pre-existing .env created by hand with 0644 perms
	// (which is what happens if the user `cat > .env` it). The
	// rewrite must tighten back to 0600.
	tmp := t.TempDir()
	globalPath := filepath.Join(tmp, "local-dev.env")
	if err := os.WriteFile(globalPath, []byte("STALE=1\n"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	_, err := WriteLocalDevEnv(LocalDevEnvOptions{
		UserID:     "u",
		AgentID:    "a",
		GlobalPath: globalPath,
	})
	if err != nil {
		t.Fatalf("WriteLocalDevEnv: %v", err)
	}

	info, err := os.Stat(globalPath)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("expected mode 0600 after overwriting 0644 file, got %o", mode)
	}

	body, _ := os.ReadFile(globalPath)
	if strings.Contains(string(body), "STALE=1") {
		t.Errorf("stale content not truncated:\n%s", body)
	}
}

func TestWriteLocalDevEnvProjectRoot(t *testing.T) {
	tmp := t.TempDir()
	globalPath := filepath.Join(tmp, "global.env")
	projectRoot := filepath.Join(tmp, "project")
	_ = os.MkdirAll(projectRoot, 0o755)

	paths, err := WriteLocalDevEnv(LocalDevEnvOptions{
		UserID:      "u",
		AgentID:     "a",
		GlobalPath:  globalPath,
		ProjectRoot: projectRoot,
	})
	if err != nil {
		t.Fatalf("WriteLocalDevEnv: %v", err)
	}
	if len(paths) != 2 {
		t.Fatalf("expected 2 paths, got %v", paths)
	}
	wantProject := filepath.Join(projectRoot, ".env")
	if paths[1] != wantProject {
		t.Errorf("expected project .env at %s, got %s", wantProject, paths[1])
	}
	if _, err := os.Stat(wantProject); err != nil {
		t.Errorf("project .env missing: %v", err)
	}
}

func TestWriteLocalDevEnvCustomSigningKey(t *testing.T) {
	tmp := t.TempDir()
	globalPath := filepath.Join(tmp, "local-dev.env")
	_, err := WriteLocalDevEnv(LocalDevEnvOptions{
		UserID:        "u",
		AgentID:       "a",
		GlobalPath:    globalPath,
		JWTSigningKey: "production-secret-do-not-leak",
	})
	if err != nil {
		t.Fatalf("WriteLocalDevEnv: %v", err)
	}
	body, _ := os.ReadFile(globalPath)
	if !strings.Contains(string(body), "KLIO_JWT_SIGNING_KEY=production-secret-do-not-leak") {
		t.Errorf("custom signing key not honored:\n%s", body)
	}
}

func TestWriteLocalDevEnvRequiresUserAndAgent(t *testing.T) {
	if _, err := WriteLocalDevEnv(LocalDevEnvOptions{AgentID: "a"}); err == nil {
		t.Error("expected error when UserID empty")
	}
	if _, err := WriteLocalDevEnv(LocalDevEnvOptions{UserID: "u"}); err == nil {
		t.Error("expected error when AgentID empty")
	}
}

func TestWriteLocalDevEnvIsIdempotent(t *testing.T) {
	tmp := t.TempDir()
	globalPath := filepath.Join(tmp, "local-dev.env")
	opts := LocalDevEnvOptions{
		UserID:     "u",
		AgentID:    "a",
		GlobalPath: globalPath,
	}

	_, err := WriteLocalDevEnv(opts)
	if err != nil {
		t.Fatalf("first write: %v", err)
	}
	first, _ := os.ReadFile(globalPath)

	_, err = WriteLocalDevEnv(opts)
	if err != nil {
		t.Fatalf("second write: %v", err)
	}
	second, _ := os.ReadFile(globalPath)

	if string(first) != string(second) {
		t.Errorf("re-running produced different bytes:\n  first:  %q\n  second: %q", first, second)
	}
}

func TestFindKlioProjectRootMatchesTrustApp(t *testing.T) {
	tmp := t.TempDir()
	root := filepath.Join(tmp, "klio")
	deep := filepath.Join(root, "engine", "scripts")
	_ = os.MkdirAll(deep, 0o755)
	composeBody := `services:
  trust-app:
    build: ./trust-app
`
	_ = os.WriteFile(filepath.Join(root, "docker-compose.yml"), []byte(composeBody), 0o644)

	got := FindKlioProjectRoot(deep)
	if got != root {
		t.Errorf("expected %s, got %s", root, got)
	}
}

func TestFindKlioProjectRootIgnoresUnrelatedCompose(t *testing.T) {
	tmp := t.TempDir()
	deep := filepath.Join(tmp, "some", "other", "project")
	_ = os.MkdirAll(deep, 0o755)
	// A compose file with no trust-app reference must NOT match.
	_ = os.WriteFile(
		filepath.Join(tmp, "docker-compose.yml"),
		[]byte("services:\n  postgres:\n    image: postgres:16\n"),
		0o644,
	)

	if got := FindKlioProjectRoot(deep); got != "" {
		t.Errorf("expected empty (no trust-app match), got %s", got)
	}
}

func TestFindKlioProjectRootEmptyStartReturnsEmpty(t *testing.T) {
	if got := FindKlioProjectRoot(""); got != "" {
		t.Errorf("expected empty for empty start, got %s", got)
	}
}

func TestFindKlioProjectRootHandlesAlternateNames(t *testing.T) {
	tmp := t.TempDir()
	_ = os.WriteFile(
		filepath.Join(tmp, "compose.yaml"),
		[]byte("services:\n  trust-app: {}\n"),
		0o644,
	)
	if got := FindKlioProjectRoot(tmp); got != tmp {
		t.Errorf("expected %s, got %s", tmp, got)
	}
}
