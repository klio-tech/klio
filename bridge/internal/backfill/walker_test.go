package backfill

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWalkDiscoversProjects(t *testing.T) {
	dir := t.TempDir()

	proj1 := filepath.Join(dir, "-Users-abhishek-oppla-klio")
	proj2 := filepath.Join(dir, "-Users-abhishek-oppla-vex")
	for _, p := range []string{proj1, proj2} {
		_ = os.MkdirAll(p, 0o755)
	}
	_ = os.WriteFile(filepath.Join(proj1, "abc-123.jsonl"), []byte("{}"+"\n"), 0o644)
	_ = os.WriteFile(filepath.Join(proj1, "def-456.jsonl"), []byte("{}"+"\n"), 0o644)
	_ = os.WriteFile(filepath.Join(proj2, "ghi-789.jsonl"), []byte("{}"+"\n"), 0o644)

	projects, err := Walk(dir)
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	if len(projects) != 2 {
		t.Fatalf("expected 2, got %d", len(projects))
	}
	for _, p := range projects {
		switch p.Slug {
		case "oppla-klio":
			if len(p.Sessions) != 2 {
				t.Errorf("oppla-klio sessions = %d", len(p.Sessions))
			}
		case "oppla-vex":
			if len(p.Sessions) != 1 {
				t.Errorf("oppla-vex sessions = %d", len(p.Sessions))
			}
		default:
			t.Errorf("unexpected slug: %s", p.Slug)
		}
	}
}

func TestDecodeSlug(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"-Users-abhishek-oppla-klio", "oppla-klio"},
		{"-Users-x-Documents-side-project", "documents-side-project"},
		{"-tmp-test", "test"},
		{"-Users-only", "default"},
		{"-", "default"},
	}
	for _, c := range cases {
		if got := decodeProjectSlug(c.in); got != c.want {
			t.Errorf("decodeProjectSlug(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
