// Package backfill walks Claude Code's session JSONL directory and ingests
// each session through the engine's extraction pipeline.
package backfill

import (
	"os"
	"path/filepath"
	"strings"
)

// Project represents one Claude Code project (one directory under
// ~/.claude/projects/).
type Project struct {
	OriginalCwd string // e.g., "/Users/abhishek/oppla/klio"
	Slug        string // e.g., "oppla-klio"
	DisplayName string // initially same as slug; user can rename in trust app
	Sessions    []SessionFile
}

// SessionFile is one *.jsonl session inside a project.
type SessionFile struct {
	Path      string
	SessionID string
}

// Walk lists all projects (and their sessions) under root.
func Walk(root string) ([]Project, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	var projects []Project
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if !strings.HasPrefix(e.Name(), "-") {
			continue
		}
		full := filepath.Join(root, e.Name())
		p, err := scanProject(full, e.Name())
		if err != nil || len(p.Sessions) == 0 {
			continue
		}
		projects = append(projects, p)
	}
	return projects, nil
}

func scanProject(dir, encoded string) (Project, error) {
	files, err := os.ReadDir(dir)
	if err != nil {
		return Project{}, err
	}
	originalCwd := strings.ReplaceAll(encoded, "-", "/")
	slug := decodeProjectSlug(encoded)
	p := Project{OriginalCwd: originalCwd, Slug: slug, DisplayName: slug}
	for _, f := range files {
		if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
			continue
		}
		p.Sessions = append(p.Sessions, SessionFile{
			Path:      filepath.Join(dir, f.Name()),
			SessionID: strings.TrimSuffix(f.Name(), ".jsonl"),
		})
	}
	return p, nil
}

// decodeProjectSlug turns the path-encoded directory name into a clean slug.
// Examples:
//
//	-Users-abhishek-oppla-klio  ->  oppla-klio
//	-tmp-test                   ->  test
//	-                           ->  default
func decodeProjectSlug(encoded string) string {
	parts := strings.Split(strings.TrimPrefix(encoded, "-"), "-")
	if len(parts) >= 2 && parts[0] == "Users" {
		parts = parts[2:]
	}
	if len(parts) >= 1 && parts[0] == "tmp" {
		parts = parts[1:]
	}
	out := strings.ToLower(strings.Join(parts, "-"))
	out = strings.Trim(out, "-")
	if out == "" {
		out = "default"
	}
	return out
}
