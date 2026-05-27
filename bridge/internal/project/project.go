// Package project resolves a working directory into a stable project
// Key — the projection the bridge sends to the engine's
// POST /v1/projects/ensure to obtain a project_id.
//
// The resolution ladder, in priority order, is:
//
//  1. `git config --get remote.origin.url` — the canonical, strongest
//     identifier. Survives directory renames; identical across linked
//     worktrees. The engine dedupes projects on `git_remote` first.
//  2. `git rev-parse --show-toplevel` — the fallback when a repo has
//     no `origin` configured (a fresh `git init`, a fork the user
//     hasn't wired up, an air-gapped vendor mirror). Survives `cd`
//     into a subdirectory.
//  3. `filepath.Abs(cwd)` — always set. The fallback for directories
//     that are not git repos at all (scratch projects, vendored
//     fixture trees, etc.). The weakest identifier — sensitive to
//     directory renames — but it's a real anchor, and `Resolve` MUST
//     produce something the engine can ensure on.
//
// Resolve is a pure function: no side effects, no caching, no logger.
// Caching belongs to the layer above (D2's LRU wrapper). Detection
// is shelled out to git because reimplementing git's config + worktree
// resolution in pure Go is a footgun — gitconfig has includes,
// conditional includes, system-level files, and several decades of
// edge cases that the official binary handles correctly.
//
// Performance: Resolve is called on every hook fire. Two short-lived
// `git` subprocesses per call (skipped when git isn't installed). The
// LRU cache in D2 amortises this to one resolution per cwd per
// process lifetime.
//
// Canonical-absent contract: the empty string ("") is the canonical
// "field not set" marker for GitRemote and RepoRootPath. The engine's
// schema enforces `min_length=1` on these fields (C1's gate logic),
// so the bridge MUST NOT send `git_remote=""` — instead, omit the
// field or send `nil` upstream. AbsCwd is always non-empty when
// Resolve returns nil error.
package project

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
)

// Key is the projection of a cwd into the engine's project namespace.
//
// Sent to POST /v1/projects/ensure as the body
// {git_remote, repo_root_path, display_name}. The engine resolves a
// stable project_id by deduping on the strongest available signal.
//
// Field invariants:
//   - AbsCwd is always non-empty when Resolve returns nil error.
//   - GitRemote and RepoRootPath are "" when their respective git
//     commands failed (no git, not a repo, no remote configured).
//     "" is the canonical absent marker — see the package docstring.
//   - DisplayName is always non-empty when Resolve returns nil error;
//     the engine truncates to 200 chars on its side, so the bridge
//     doesn't pre-trim.
type Key struct {
	// GitRemote is `git config --get remote.origin.url` for the
	// repo containing cwd. Empty if cwd is not in a git repo, or if
	// the repo has no `origin` configured.
	GitRemote string

	// RepoRootPath is `git rev-parse --show-toplevel` — the absolute
	// path to the repo's working tree root. Empty if cwd is not in a
	// git repo. Note that git resolves symlinks here; on macOS,
	// `/var/...` becomes `/private/var/...`.
	RepoRootPath string

	// AbsCwd is filepath.Abs(cwd). Always set when Resolve returns
	// nil error. The weakest project signal (sensitive to directory
	// renames), but the only one that's universally available.
	AbsCwd string

	// DisplayName is the human-friendly UI label the engine writes to
	// `projects.display_name`. Derived from (in priority order)
	// the parsed `org/repo` of GitRemote, or basename(RepoRootPath),
	// or basename(AbsCwd).
	DisplayName string
}

// Resolve projects cwd into a project Key by walking the
// git → fs ladder described in the package docstring.
//
// Returns an error ONLY when filepath.Abs(cwd) fails, which on a sane
// POSIX filesystem requires a pathologically broken environment
// (e.g. the process's own cwd has been removed and cwd is relative).
// Missing git, non-git directories, and repos without an `origin`
// remote degrade through the ladder — they do not produce errors.
func Resolve(ctx context.Context, cwd string) (Key, error) {
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return Key{}, fmt.Errorf("filepath.Abs(%q): %w", cwd, err)
	}

	remote := gitRemoteOrigin(ctx, abs)
	root := gitToplevel(ctx, abs)
	display := deriveDisplayName(remote, root, abs)

	return Key{
		GitRemote:    remote,
		RepoRootPath: root,
		AbsCwd:       abs,
		DisplayName:  display,
	}, nil
}

// deriveDisplayName picks the strongest available signal and turns
// it into a UI label, in the order: remote → root → cwd. At least one
// of root/abs is always non-empty (abs is guaranteed), so this never
// returns "".
func deriveDisplayName(remote, root, abs string) string {
	if remote != "" {
		return displayFromRemote(remote)
	}
	if root != "" {
		return filepath.Base(root)
	}
	return filepath.Base(abs)
}

// displayFromRemote extracts an `org/repo` (or `group/subgroup/repo`
// for GitLab-style nesting) from a git remote URL. Supports the two
// dominant remote shapes:
//
//   - SCP-style SSH: `git@github.com:org/repo.git`
//   - HTTPS / ssh:// : `https://github.com/org/repo[.git]`
//
// Anything that doesn't match either shape is returned verbatim
// (trimmed). The engine sees the raw remote in that case — never the
// empty string, which would trip C1's `min_length=1` schema gate.
//
// Public-API note: this is unexported because the engine, not the
// bridge, is the source of truth for display name normalisation
// across heterogeneous remotes. Keep parsing here minimal; defer
// fancy cleanup to the engine when needed.
//
// TODO(0.7.x security follow-up): strip userinfo from HTTPS remotes
// before returning. `https://token:secret@host/...` URLs land verbatim
// in Key.GitRemote today, which means the engine could persist
// credentials embedded in the user's git config. Not a v0.7 blocker
// (most users have no credentials in their remote URL), but a real
// privacy concern worth closing in 0.7.x.
func displayFromRemote(remote string) string {
	r := strings.TrimSpace(remote)
	if r == "" {
		return ""
	}

	// Strip a trailing `.git` once (the conventional suffix, present
	// on the HTTPS clone URL Github surfaces by default). Multiple
	// `.git.git` would be operator error and isn't worth handling.
	r = strings.TrimSuffix(r, ".git")

	// SCP-style SSH: `git@host:path` (no scheme). Distinguished from
	// the URL forms by the absence of `://` and the presence of a `:`
	// after the user@host segment.
	if !strings.Contains(r, "://") {
		if i := strings.Index(r, ":"); i >= 0 {
			path := r[i+1:]
			if path != "" {
				return path
			}
		}
		// No `:` separator — not a remote shape we recognise. Fall
		// through to the verbatim passthrough below.
		return r
	}

	// URL forms: `scheme://[user@]host[:port]/path`. We just want the
	// path, minus a leading slash. `strings.SplitN(r, "://", 2)[1]`
	// is safe because the `://` check above already guaranteed it.
	afterScheme := strings.SplitN(r, "://", 2)[1]
	slash := strings.Index(afterScheme, "/")
	if slash < 0 {
		// No path component (e.g. `https://github.com`). Not a remote
		// we can usefully name from — passthrough.
		return r
	}
	path := strings.TrimPrefix(afterScheme[slash:], "/")
	if path == "" {
		return r
	}
	return path
}

// gitRemoteOrigin returns `git config --get remote.origin.url` for
// the repo containing dir, or "" if the command fails for any reason
// (git not installed, dir not in a repo, no `origin` remote).
//
// stderr is suppressed: D1 has no logger context, and the
// ladder-falls-through-on-error model means a missing remote is a
// normal, expected outcome — not a bug surface.
func gitRemoteOrigin(ctx context.Context, dir string) string {
	return runGit(ctx, dir, "config", "--get", "remote.origin.url")
}

// gitToplevel returns `git rev-parse --show-toplevel` for the repo
// containing dir, or "" if the command fails (git not installed, dir
// not in a repo).
//
// Note: git resolves symlinks in the returned path. On macOS,
// `t.TempDir()` returns `/var/folders/...` (a symlink to
// `/private/var/folders/...`), and `--show-toplevel` returns the
// resolved form. Callers comparing against a TempDir path must
// `filepath.EvalSymlinks` first.
func gitToplevel(ctx context.Context, dir string) string {
	return runGit(ctx, dir, "rev-parse", "--show-toplevel")
}

// runGit invokes `git <args...>` with cwd=dir and returns the trimmed
// stdout, or "" on any failure (non-zero exit, exec error, missing
// binary). stderr is intentionally swallowed — see gitRemoteOrigin.
//
// Why we exec git rather than parsing .git/config in pure Go:
// .git/config has includes, conditional includes, system-level
// /etc/gitconfig, the user's ~/.gitconfig, and a couple of decades
// of edge cases. The git binary is the only authoritative
// interpreter, and it's installed on every dev machine we target.
//
// TODO(D2): exec.Command resolves "git" via $PATH on every call.
// For 200 hook fires per session this is wasted work. When D2's
// LRU cache lands, resolve the absolute git path once and use it
// for all subsequent calls.
func runGit(ctx context.Context, dir string, args ...string) string {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	// Discard stderr explicitly so a `git: command not found` from
	// /usr/libexec doesn't leak into the caller's stderr stream.
	cmd.Stderr = nil
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
