// `npm test`, run inside a throwaway HOME.
//
// Half of this package's job is writing agent config —
// ~/.claude/settings.json, ~/.codex/config.toml,
// ~/.klio/proxy-wiring.json — and every path to it is derived from
// `os.homedir()`, which on POSIX is `$HOME`. Tests that exercise those
// code paths are supposed to redirect HOME at a tmpdir first. The ones
// that forget do not fail; they rewrite the DEVELOPER'S OWN
// configuration and pass, and the damage is found days later.
//
// That is not hypothetical, and it is not a one-off. It has now
// happened twice in this file's history: once through
// `installSupervisor` rewriting the real launchd agent, and once
// through `wireProxyStack` reaching the real `wireProxy` and rewriting
// ~/.claude/settings.json — each time with a green suite. Both were
// fixed by adding the missing seam to the individual test, which fixes
// the instance and not the class: the next test to omit a seam has the
// same reach.
//
// So the suite runs with HOME pointed at a fresh temp directory that is
// deleted afterwards. A test that forgets to isolate now scribbles on
// scratch instead of the developer's home, and the CHILD PROCESSES
// tests spawn inherit the same jail — which an in-process guard cannot
// do. It does not replace per-test seams (a hijacked launchd label is
// still global, and no HOME redirects it); it bounds the blast radius
// of forgetting one.
//
// Deliberately not a devDependency: zero runtime dependencies is a
// constraint of this package, and the test runner is `node --test`.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "klio-test-home-"));

const child = spawn(
  process.execPath,
  ["--test", "--import", "tsx", ...(process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : ["tests/**/*.test.ts"])],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      // Codex reads this before ~/.codex, so a test that drives the
      // Codex adapter without an explicit path stays in the jail too.
      CODEX_HOME: join(home, ".codex"),
    },
  },
);

function cleanup() {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // A temp directory we cannot remove is not a test failure.
  }
}

child.on("error", (err) => {
  cleanup();
  console.error(`could not start the test runner: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  cleanup();
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
