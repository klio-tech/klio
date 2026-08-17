// Unit tests for the shared project-identity resolver (src/project.ts) —
// the one place `klio hook` and the cloud proxy both derive `repo_root`/
// `git_remote` from a directory, so they answer "what project is this"
// the same way. hook.test.ts already exercises this indirectly through
// `runHook`; this file is the resolver's own contract, including the
// fail-open guarantee a proxy at startup depends on.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { resolveProject } from "../src/project.js";

test("no cwd resolves to nothing — fail-open, no fields at all", () => {
  assert.deepEqual(resolveProject(undefined), {});
});

test("a cwd with no git remote yields repo_root only", () => {
  const out = resolveProject("/repo/klio", { gitRemoteFn: () => null });
  assert.deepEqual(out, { repo_root: "/repo/klio" });
});

test("a cwd that is a git repo yields both repo_root and git_remote", () => {
  const out = resolveProject("/repo/klio", {
    gitRemoteFn: () => "git@github.com:klio-tech/klio.git",
  });
  assert.deepEqual(out, {
    repo_root: "/repo/klio",
    git_remote: "git@github.com:klio-tech/klio.git",
  });
});

test("a gitRemoteFn that throws is not this module's problem — it is a caller contract", () => {
  // resolveProject calls the injected gitRemoteFn directly and does not
  // wrap it; defaultGitRemote (the production implementation) is the one
  // that guarantees never-throws by catching internally. A test seam
  // that violates that contract is expected to propagate, not be
  // silently swallowed here — the swallowing is defaultGitRemote's job,
  // proven separately below.
  assert.throws(() =>
    resolveProject("/repo", {
      gitRemoteFn: () => {
        throw new Error("boom");
      },
    }),
  );
});

test("defaultGitRemote never throws for a directory with no git remote", async () => {
  const { defaultGitRemote } = await import("../src/project.js");
  // A directory almost certainly not inside a git repo (or, if it is,
  // one this test does not control the remote of) — either way the
  // function must return a value, never throw.
  const out = defaultGitRemote("/");
  assert.ok(out === null || typeof out === "string");
});
