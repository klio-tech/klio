// Unit tests for the shared project-identity resolver (src/project.ts) —
// the one place `klio hook` derives `repo_root`/`git_remote` from a
// directory. hook.test.ts already exercises this indirectly through
// `runHook`; this file is the resolver's own contract.
//
// NOTE: `repo_root` is set unconditionally whenever a `cwd` is given at
// all — including a `cwd` that is not a git repo. `{}` (no fields)
// happens ONLY when no `cwd` is given. See src/project.ts's module
// docblock for why that distinction is exactly what makes this module,
// on its own, unsuitable for a caller (like the proxy) that cannot
// confirm the `cwd` it has is actually the right project.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { resolveProject } from "../src/project.js";

test("no cwd resolves to nothing — the only case that sends no fields", () => {
  assert.deepEqual(resolveProject(undefined), {});
});

test("a cwd with no git remote still yields repo_root — not {}", () => {
  const out = resolveProject("/repo/klio", { gitRemoteFn: () => null });
  assert.deepEqual(out, { repo_root: "/repo/klio" });
});

test("a cwd that is not a git repo at all still yields repo_root, not {}", () => {
  // The concrete case that made proxy-side wiring unsafe: a directory
  // that is not even a plausible project still comes back with a
  // populated, plausible-looking repo_root.
  const out = resolveProject("/nonexistent-dir-xyz", { gitRemoteFn: () => null });
  assert.deepEqual(out, { repo_root: "/nonexistent-dir-xyz" });
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

test("a gitRemoteFn that throws does not propagate — resolveProject never throws", () => {
  // resolveProject is documented never to throw. defaultGitRemote (the
  // production implementation) guarantees that by catching internally,
  // but the injected `gitRemoteFn` seam is caller-supplied and was not
  // wrapped — so a misbehaving seam broke the module's own contract.
  // Fixed: the catch now lives in resolveProject itself too.
  const out = resolveProject("/repo", {
    gitRemoteFn: () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(out, { repo_root: "/repo" }, "a throwing gitRemoteFn degrades to no git_remote, not a crash");
});

test("defaultGitRemote never throws for a directory with no git remote", async () => {
  const { defaultGitRemote } = await import("../src/project.js");
  // A directory almost certainly not inside a git repo (or, if it is,
  // one this test does not control the remote of) — either way the
  // function must return a value, never throw.
  const out = defaultGitRemote("/");
  assert.ok(out === null || typeof out === "string");
});
