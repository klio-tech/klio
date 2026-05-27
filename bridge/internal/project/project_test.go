package project

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// run shells out to a binary (always `git` in this file) with a
// scrubbed env that pins author/committer identity. Hermetic — every
// test starts from a fresh temp dir, no dependency on the developer's
// global ~/.gitconfig (which on a CI box may not exist).
func run(t *testing.T, dir string, name string, args ...string) {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@test",
		"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@test",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%s %v in %s: %v: %s", name, args, dir, err, string(out))
	}
}

// initRepo initialises a temp git repo on the `main` branch with
// identity envs so subsequent `git commit` calls don't fail on a CI
// box without a global gitconfig. Returns the absolute repo path.
func initRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run(t, dir, "git", "init", "-q", "-b", "main")
	return dir
}

// TestResolveGitRepoWithRemote — the happy path: cwd is a git repo
// with `remote.origin.url` set. All four Key fields populate;
// DisplayName comes from the remote (the strongest signal).
func TestResolveGitRepoWithRemote(t *testing.T) {
	dir := initRepo(t)
	run(t, dir, "git", "remote", "add", "origin", "git@github.com:klio-tech/klio.git")

	got, err := Resolve(context.Background(), dir)
	if err != nil {
		t.Fatalf("Resolve(%q) error: %v", dir, err)
	}
	if got.GitRemote != "git@github.com:klio-tech/klio.git" {
		t.Errorf("GitRemote = %q, want git@github.com:klio-tech/klio.git", got.GitRemote)
	}
	// `git rev-parse --show-toplevel` resolves symlinks (e.g. /var ->
	// /private/var on macOS), so compare against the resolved abs path
	// rather than the raw `dir` returned by t.TempDir().
	wantRoot, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("EvalSymlinks(%q): %v", dir, err)
	}
	if got.RepoRootPath != wantRoot {
		t.Errorf("RepoRootPath = %q, want %q", got.RepoRootPath, wantRoot)
	}
	wantAbs, err := filepath.Abs(dir)
	if err != nil {
		t.Fatalf("Abs(%q): %v", dir, err)
	}
	if got.AbsCwd != wantAbs {
		t.Errorf("AbsCwd = %q, want %q", got.AbsCwd, wantAbs)
	}
	if got.DisplayName != "klio-tech/klio" {
		t.Errorf("DisplayName = %q, want klio-tech/klio", got.DisplayName)
	}
}

// TestResolveGitRepoNoRemote — `git init` with no remote configured.
// Step 1 of the ladder returns nothing; step 2 still yields the
// toplevel; DisplayName falls back to basename(root).
func TestResolveGitRepoNoRemote(t *testing.T) {
	dir := initRepo(t)

	got, err := Resolve(context.Background(), dir)
	if err != nil {
		t.Fatalf("Resolve(%q) error: %v", dir, err)
	}
	if got.GitRemote != "" {
		t.Errorf("GitRemote = %q, want empty", got.GitRemote)
	}
	if got.RepoRootPath == "" {
		t.Errorf("RepoRootPath empty, want git toplevel")
	}
	if got.AbsCwd == "" {
		t.Errorf("AbsCwd empty, want abspath(cwd)")
	}
	if got.DisplayName != filepath.Base(got.RepoRootPath) {
		t.Errorf("DisplayName = %q, want %q (basename of repo root)", got.DisplayName, filepath.Base(got.RepoRootPath))
	}
}

// TestResolveNonGitDirectory — cwd is not a git repo at all. Steps 1
// and 2 both fail; step 3 always succeeds; DisplayName falls back to
// basename(cwd).
func TestResolveNonGitDirectory(t *testing.T) {
	dir := t.TempDir()

	got, err := Resolve(context.Background(), dir)
	if err != nil {
		t.Fatalf("Resolve(%q) error: %v", dir, err)
	}
	if got.GitRemote != "" {
		t.Errorf("GitRemote = %q, want empty", got.GitRemote)
	}
	if got.RepoRootPath != "" {
		t.Errorf("RepoRootPath = %q, want empty (not a git repo)", got.RepoRootPath)
	}
	if got.AbsCwd == "" {
		t.Errorf("AbsCwd empty, want abspath(cwd)")
	}
	if got.DisplayName != filepath.Base(got.AbsCwd) {
		t.Errorf("DisplayName = %q, want %q (basename of cwd)", got.DisplayName, filepath.Base(got.AbsCwd))
	}
}

// TestResolveDeriveDisplayFromHTTPSRemote — same as the SSH happy path
// but with an HTTPS remote that has a trailing `.git`. Confirms the
// scheme-agnostic parser strips the suffix and yields `org/repo`.
func TestResolveDeriveDisplayFromHTTPSRemote(t *testing.T) {
	dir := initRepo(t)
	run(t, dir, "git", "remote", "add", "origin", "https://github.com/klio-tech/klio.git")

	got, err := Resolve(context.Background(), dir)
	if err != nil {
		t.Fatalf("Resolve(%q) error: %v", dir, err)
	}
	if got.DisplayName != "klio-tech/klio" {
		t.Errorf("DisplayName = %q, want klio-tech/klio", got.DisplayName)
	}
}

// TestResolveWorktreeSharesRemote — the whole point of using
// `remote.origin.url` as the strongest signal: a linked worktree
// (different working directory, different `.git` file, same logical
// project) resolves to the *same* GitRemote and therefore to the same
// project_id in the engine. The regression test guards against a
// future change that derives the Key from a path that differs between
// the main repo and a linked worktree.
func TestResolveWorktreeSharesRemote(t *testing.T) {
	main := initRepo(t)
	run(t, main, "git", "remote", "add", "origin", "git@github.com:klio-tech/klio.git")
	// `git worktree add` requires at least one commit on HEAD, so make
	// an empty one. -q suppresses noise.
	run(t, main, "git", "commit", "--allow-empty", "-m", "init", "-q")

	// Worktree must live OUTSIDE the main repo's tree (git refuses to
	// nest one worktree inside another).
	worktreeBase := t.TempDir()
	worktreePath := filepath.Join(worktreeBase, "wt")
	run(t, main, "git", "worktree", "add", "-q", worktreePath)

	mainKey, err := Resolve(context.Background(), main)
	if err != nil {
		t.Fatalf("Resolve(main): %v", err)
	}
	wtKey, err := Resolve(context.Background(), worktreePath)
	if err != nil {
		t.Fatalf("Resolve(worktree): %v", err)
	}
	if mainKey.GitRemote == "" {
		t.Fatalf("main GitRemote empty; remote setup failed")
	}
	if mainKey.GitRemote != wtKey.GitRemote {
		t.Errorf("worktree GitRemote = %q, want %q (same as main)", wtKey.GitRemote, mainKey.GitRemote)
	}
}

// TestDisplayNameFromRemoteExportedWrapper verifies the exported
// wrapper (`DisplayNameFromRemote`) routes to the same parser as the
// unexported `displayFromRemote`. The wrapper exists so external
// callers (e.g. `klio project promote <remote>`) can derive a display
// name without fabricating a cwd to feed into Resolve; if a future
// refactor accidentally diverges the two, this test catches it.
func TestDisplayNameFromRemoteExportedWrapper(t *testing.T) {
	cases := []string{
		"git@github.com:klio-tech/klio.git",
		"https://gitlab.com/group/subgroup/project",
		"",
		"  not-a-url  ",
	}
	for _, in := range cases {
		if got, want := DisplayNameFromRemote(in), displayFromRemote(in); got != want {
			t.Errorf("DisplayNameFromRemote(%q) = %q, displayFromRemote = %q", in, got, want)
		}
	}
}

// TestDisplayFromRemote — the table-driven survey of remote URL
// shapes. Documented in the task: SSH, HTTPS, HTTPS-with-.git, the
// ssh:// scheme variant, GitLab nested subgroups, and the "anything
// else" passthrough.
func TestDisplayFromRemote(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"git@github.com:klio-tech/klio.git", "klio-tech/klio"},
		{"https://github.com/klio-tech/klio", "klio-tech/klio"},
		{"https://github.com/klio-tech/klio.git", "klio-tech/klio"},
		{"ssh://git@github.com:22/org/repo.git", "org/repo"},
		{"https://gitlab.com/group/subgroup/project", "group/subgroup/project"},
		{"", ""},
		// Unparseable garbage: the function returns the trimmed input
		// verbatim. The engine will see the raw remote — never `""`,
		// which would trip the schema's min_length=1 gate.
		{"  not-a-url  ", "not-a-url"},
	}
	for _, tc := range cases {
		got := displayFromRemote(tc.in)
		if got != tc.want {
			t.Errorf("displayFromRemote(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
