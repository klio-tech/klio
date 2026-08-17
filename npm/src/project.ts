// Project identity resolution — shared by `klio hook` (per-invocation,
// known cwd) and the cloud proxy (long-lived daemon, no per-request cwd).
//
// The engine scopes recall to a caller's project via two signals:
// `repo_root` and `git_remote`. This module is the ONE place that derives
// them from a directory, so the hook and the proxy answer "what project is
// this" the same way instead of drifting into two resolvers with two sets
// of edge cases.
//
// FAIL-OPEN BY CONTRACT: a directory that cannot be resolved (not a git
// repo, `git` missing, a filesystem error) yields `{}` — no fields at all —
// rather than a guess. Callers that spread `{}` into a request body send
// nothing extra, which is exactly today's unscoped behaviour. Never throws.

import { execFileSync } from "node:child_process";

/** The two project-identity fields the engine's `RecallRequest` accepts. */
export type ResolvedProject = { repo_root?: string; git_remote?: string };

/** Injectable seam so callers can test resolution hermetically — no real git. */
export type ProjectDeps = {
  /** Resolve `origin`'s git remote URL for a cwd; null on any failure. */
  gitRemoteFn?: (cwd: string) => string | null;
};

/**
 * Derive best-effort project identity from a cwd: the repo root (the cwd
 * itself — callers are expected to pass a directory that IS the project
 * root, not an arbitrary subdirectory), plus the git remote when the
 * directory is a git repo. The server uses these to file/recall memories
 * per project.
 */
export function resolveProject(cwd: string | undefined, deps: ProjectDeps = {}): ResolvedProject {
  if (!cwd) return {};
  const out: ResolvedProject = { repo_root: cwd };
  const gitFn = deps.gitRemoteFn ?? defaultGitRemote;
  const remote = gitFn(cwd);
  if (remote) out.git_remote = remote;
  return out;
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
