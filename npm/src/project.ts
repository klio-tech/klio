// Project identity resolution — shared by `klio hook` (per-invocation,
// known cwd) and (as a building block only — see recall.ts and server.ts
// for why nothing wires it in yet) the cloud proxy.
//
// The engine scopes recall to a caller's project via two signals:
// `repo_root` and `git_remote`. This module is the ONE place that derives
// them from a directory, so a future caller (the hook today; a
// per-request-attributed proxy path later) answers "what project is this"
// the same way instead of drifting into two resolvers with two sets of
// edge cases.
//
// WHAT "FAIL-OPEN" ACTUALLY MEANS HERE — read before assuming a
// non-git directory yields `{}`. It does not.
//
//   * NO cwd at all (`undefined` — e.g. a hook payload that omits it)
//     yields `{}`: no fields, nothing sent. This is the only case that
//     degrades to "send nothing".
//   * ANY cwd, git repo or not, yields `repo_root: cwd` UNCONDITIONALLY.
//     `repo_root` is the raw directory a caller resolved this against —
//     there is no `git rev-parse --show-toplevel` anywhere in this
//     module, so it is NOT necessarily a git repository's actual top
//     level, and it is sent even for a directory with no git repo at
//     all. Measured: `resolveProject("/")` → `{repo_root: "/"}`;
//     `resolveProject("/nonexistent-dir-xyz")` →
//     `{repo_root: "/nonexistent-dir-xyz"}`.
//   * `git_remote` is the only field that depends on git succeeding:
//     present only when the directory is inside a git repo with an
//     `origin` remote, absent for everything else (not a repo, no
//     `origin`, `git` missing, a filesystem error).
//
// So a caller that wants "send nothing unless we're confident this is a
// real, identifiable project" cannot rely on this module alone — it has
// to check for an empty `ResolvedProject`, which happens only on a
// missing cwd, not on a bad one. This distinction is exactly what made
// wiring `repo_root: process.cwd()` into the proxy unsafe: a `cwd` that
// resolves to a REAL BUT WRONG project (a git repo, just not the
// caller's) still yields a fully-populated, plausible-looking
// `ResolvedProject` — there is no "this doesn't look right" signal to
// catch it on.
//
// NEVER THROWS — including when the injected `gitRemoteFn` seam does.

import { execFileSync } from "node:child_process";

/** The project-identity fields the engine's capture endpoints accept. */
export type ResolvedProject = {
  repo_root?: string;
  git_remote?: string;
  /**
   * The current git branch, so hook captures land on the project's context
   * branch of the same name (engine Track C). Omitted for the default branch
   * — `main`/`master` IS the absence of a branch — and for a detached HEAD,
   * whose `rev-parse --abbrev-ref` output is the literal string `HEAD`.
   */
  git_branch?: string;
};

/** Injectable seam so callers can test resolution hermetically — no real git. */
export type ProjectDeps = {
  /** Resolve `origin`'s git remote URL for a cwd; null on any failure. */
  gitRemoteFn?: (cwd: string) => string | null;
  /** Resolve the current git branch name for a cwd; null on any failure. */
  gitBranchFn?: (cwd: string) => string | null;
};

/**
 * Derive best-effort project identity from a cwd: `repo_root` is the cwd
 * itself, sent whenever a cwd is given at all — see the module docblock
 * for why that is NOT the same thing as "this is confirmed to be a real
 * project" — plus `git_remote` when the directory is a git repo with an
 * `origin`. `{}` (both fields absent) happens only when no `cwd` is
 * given at all.
 */
export function resolveProject(cwd: string | undefined, deps: ProjectDeps = {}): ResolvedProject {
  if (!cwd) return {};
  const out: ResolvedProject = { repo_root: cwd };
  const gitFn = deps.gitRemoteFn ?? defaultGitRemote;
  // `defaultGitRemote` already catches internally, but an INJECTED
  // `gitRemoteFn` (the test seam) is caller-supplied and this function
  // is documented never to throw — so the catch lives here too, not
  // just in the production implementation, or a misbehaving seam (or a
  // future non-git-based resolver) would violate a contract this
  // module's own docblock advertises.
  let remote: string | null;
  try {
    remote = gitFn(cwd);
  } catch {
    remote = null;
  }
  if (remote) out.git_remote = remote;
  const branchFn = deps.gitBranchFn ?? defaultGitBranch;
  let branch: string | null;
  try {
    branch = branchFn(cwd);
  } catch {
    branch = null;
  }
  // `main`/`master` map to "no branch": the engine treats the default branch
  // as main (branch_id NULL), and `HEAD` is what a detached checkout reports.
  if (branch && !["main", "master", "head"].includes(branch.toLowerCase())) {
    out.git_branch = branch;
  }
  return out;
}

/** Resolve the current git branch for a cwd; null on any failure. */
export function defaultGitBranch(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/** Resolve `origin`'s git remote URL for a cwd; null on any failure. */
export function defaultGitRemote(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    const trimmed = out.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}
