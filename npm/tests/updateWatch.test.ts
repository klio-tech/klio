/**
 * `klio update --watch` — the host-side watcher that consumes
 * update-pending.json sentinels written by the bridge daemon and
 * runs `docker compose pull && up -d` on the host.
 *
 * These tests exercise a SINGLE tick (`runWatchTick`) because that's
 * the non-trivial logic. The outer poll loop is a thin wrapper that
 * calls runWatchTick on a fixed interval and ctrl-C exits cleanly —
 * its own correctness is "does it call runWatchTick", which is below
 * the bar for unit-testing.
 *
 * v0.6.1 — added together with the bridge-side sentinel writer, fixing
 * the v0.6.0 production bug where the bridge tried to run `docker`
 * inside its own container (no docker CLI present → permanent
 * `last_apply_error: exec: "docker": executable file not found`).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import {
  runWatchTick,
  type WatchTickOptions,
} from "../src/commands/updateWatch.js";


type TestCtx = { after: (fn: () => void) => void };


/**
 * Build a temp directory laid out the way ~/.klio is on a real host:
 * an existing update-state.json, a docker-compose.yml, and (for
 * happy-path tests) an update-pending.json sentinel.
 */
function setupKlioDir(t: TestCtx, opts: {
  pending?: { target_version: string; requested_at?: string; requested_by?: string };
  state?: { current_version?: string; last_known_available_version?: string };
  envContent?: string;
}): { dir: string; statePath: string; pendingPath: string; composePath: string; envPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "klio-watch-test-"));
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  const statePath = join(dir, "update-state.json");
  const pendingPath = join(dir, "update-pending.json");
  const composePath = join(dir, "docker-compose.yml");
  const envPath = join(dir, ".env");

  writeFileSync(
    statePath,
    JSON.stringify(opts.state ?? { current_version: "0.6.0" }, null, 2),
  );
  // We never actually exec docker compose against this file — the
  // composeApply hook is stubbed — but the watcher reads it to recover
  // KLIO_JWT_SIGNING_KEY for the re-render.
  writeFileSync(
    envPath,
    opts.envContent ?? "KLIO_JWT_SIGNING_KEY=sentinel-jwt\n",
  );
  writeFileSync(composePath, "# placeholder compose body\n");
  if (opts.pending) {
    writeFileSync(
      pendingPath,
      JSON.stringify(
        {
          target_version: opts.pending.target_version,
          requested_at: opts.pending.requested_at ?? new Date().toISOString(),
          requested_by: opts.pending.requested_by ?? "bridge-auto-update",
        },
        null,
        2,
      ),
    );
  }
  return { dir, statePath, pendingPath, composePath, envPath };
}


function captureStdout(): { stdout: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stdout, chunks };
}


function makeOpts(
  paths: { dir: string; statePath: string; pendingPath: string; composePath: string; envPath: string },
  overrides: Partial<WatchTickOptions> = {},
): WatchTickOptions {
  const { stdout } = captureStdout();
  return {
    klioDir: paths.dir,
    statePath: paths.statePath,
    pendingPath: paths.pendingPath,
    composeFilePath: paths.composePath,
    envPath: paths.envPath,
    stdout,
    composeApply: async () => {
      /* no-op default — tests that care override it */
    },
    ...overrides,
  };
}


// --- Tick behaviour -----------------------------------------------


test("runWatchTick is a no-op when no sentinel exists", async (t: TestCtx) => {
  const paths = setupKlioDir(t, {});
  let calls = 0;
  const opts = makeOpts(paths, {
    composeApply: async () => {
      calls++;
    },
  });

  const result = await runWatchTick(opts);

  assert.equal(result.applied, false, "no apply should have happened");
  assert.equal(result.reason, "no-pending");
  assert.equal(calls, 0, "compose must NOT be invoked when no sentinel");
});


test("runWatchTick applies when a valid sentinel exists", async (t: TestCtx) => {
  const paths = setupKlioDir(t, {
    pending: { target_version: "0.6.1" },
    state: { current_version: "0.6.0" },
  });
  const composeCalls: string[][] = [];
  const opts = makeOpts(paths, {
    composeApply: async (args) => {
      composeCalls.push([...args]);
    },
  });

  const result = await runWatchTick(opts);

  assert.equal(result.applied, true);
  assert.equal(result.targetVersion, "0.6.1");

  // Pull + up = 2 compose calls.
  assert.equal(composeCalls.length, 2, `expected pull+up; got: ${JSON.stringify(composeCalls)}`);
  assert.ok(composeCalls[0].includes("pull"), `first call must be pull: ${JSON.stringify(composeCalls[0])}`);
  assert.ok(
    composeCalls[1].includes("up") && composeCalls[1].includes("-d"),
    `second call must be 'up -d': ${JSON.stringify(composeCalls[1])}`,
  );
  assert.ok(
    composeCalls[1].includes("engine") &&
      composeCalls[1].includes("bridge") &&
      composeCalls[1].includes("trust-app"),
    `up must include all three klio services: ${JSON.stringify(composeCalls[1])}`,
  );
});


test("runWatchTick removes the sentinel after a successful apply", async (t: TestCtx) => {
  const paths = setupKlioDir(t, {
    pending: { target_version: "0.6.1" },
  });
  assert.ok(existsSync(paths.pendingPath), "precondition: sentinel exists");

  const opts = makeOpts(paths);
  const result = await runWatchTick(opts);

  assert.equal(result.applied, true);
  assert.ok(
    !existsSync(paths.pendingPath),
    "sentinel must be deleted after a successful apply",
  );
});


test("runWatchTick updates state.json after a successful apply", async (t: TestCtx) => {
  const paths = setupKlioDir(t, {
    pending: { target_version: "0.6.1" },
    state: { current_version: "0.6.0" },
  });

  const opts = makeOpts(paths);
  await runWatchTick(opts);

  const state = JSON.parse(readFileSync(paths.statePath, "utf8")) as Record<string, unknown>;
  assert.equal(state.last_applied_version, "0.6.1", `state: ${JSON.stringify(state)}`);
  // current_version should also be advanced — once the apply
  // succeeds, what's running on the host IS the target version,
  // and dashboards reading current_version should immediately see
  // the new value (the bridge ticker on the new image will overwrite
  // it again on its next tick, but the watcher is the authoritative
  // post-apply update).
  assert.equal(state.current_version, "0.6.1", `state: ${JSON.stringify(state)}`);
  assert.ok(
    typeof state.last_applied_at === "string" && (state.last_applied_at as string).length > 0,
    `last_applied_at must be set, got: ${JSON.stringify(state.last_applied_at)}`,
  );
  assert.ok(
    !state.last_apply_error,
    `last_apply_error must be cleared on success, got: ${JSON.stringify(state.last_apply_error)}`,
  );
});


test("runWatchTick refuses non-semver target_version and writes last_apply_error", async (t: TestCtx) => {
  const paths = setupKlioDir(t, {
    pending: { target_version: "not-a-version" },
  });
  let calls = 0;
  const opts = makeOpts(paths, {
    composeApply: async () => {
      calls++;
    },
  });

  const result = await runWatchTick(opts);

  assert.equal(result.applied, false);
  assert.equal(result.reason, "invalid-target");
  assert.equal(calls, 0, "compose must NOT run for an invalid target");

  const state = JSON.parse(readFileSync(paths.statePath, "utf8")) as Record<string, unknown>;
  assert.ok(
    typeof state.last_apply_error === "string" &&
      (state.last_apply_error as string).includes("not-a-version"),
    `last_apply_error must mention the bogus version: ${JSON.stringify(state.last_apply_error)}`,
  );
  // The sentinel must be removed for an invalid target so the
  // watcher doesn't loop on the same bad input every tick. The bridge
  // will rewrite it next time it sees a valid registry response.
  assert.ok(!existsSync(paths.pendingPath), "invalid sentinel must be removed to avoid a tight loop");
});


test("runWatchTick keeps the sentinel and surfaces error when compose pull fails", async (t: TestCtx) => {
  const paths = setupKlioDir(t, {
    pending: { target_version: "0.6.1" },
  });
  const opts = makeOpts(paths, {
    composeApply: async (args) => {
      if (args.includes("pull")) {
        throw new Error("rate-limited by registry");
      }
    },
  });

  const result = await runWatchTick(opts);

  assert.equal(result.applied, false);
  assert.equal(result.reason, "compose-failed");

  // Sentinel STAYS — the host watcher will retry on the next tick.
  // Without this, a transient docker-hub rate-limit would silently
  // discard the update and the user's stack would never advance.
  assert.ok(existsSync(paths.pendingPath), "sentinel must persist on transient compose failure");

  const state = JSON.parse(readFileSync(paths.statePath, "utf8")) as Record<string, unknown>;
  assert.ok(
    typeof state.last_apply_error === "string" &&
      (state.last_apply_error as string).includes("rate-limited"),
    `last_apply_error must mention the underlying compose error: ${JSON.stringify(state.last_apply_error)}`,
  );
  assert.equal(
    state.last_applied_version,
    undefined,
    "last_applied_version must NOT advance on failure",
  );
});


test("runWatchTick uses KLIO_JWT_SIGNING_KEY from .env when re-rendering compose", async (t: TestCtx) => {
  // The watcher re-renders docker-compose.yml so subsequent docker
  // compose invocations the user runs by hand also see the pinned
  // tag. Re-rendering needs the JWT key from .env to keep auth
  // working — losing it would log every user out.
  const paths = setupKlioDir(t, {
    pending: { target_version: "0.6.1" },
    envContent: "KLIO_JWT_SIGNING_KEY=preserved-jwt\nKLIO_OPENROUTER_API_KEY=sk-or-x\n",
  });

  const opts = makeOpts(paths);
  await runWatchTick(opts);

  const composeBody = readFileSync(paths.composePath, "utf8");
  // The re-rendered template embeds the new tag. We don't assert on
  // the JWT value being literally in the compose (it's interpolated
  // via env at runtime), only that the rewrite happened.
  assert.ok(
    composeBody.includes("klio-engine:0.6.1"),
    `expected re-rendered compose pinned to 0.6.1, got: ${composeBody.slice(0, 200)}`,
  );

  // The .env must be untouched — the re-render reads from .env, it
  // doesn't write back to it.
  const envAfter = readFileSync(paths.envPath, "utf8");
  assert.ok(envAfter.includes("KLIO_JWT_SIGNING_KEY=preserved-jwt"));
  assert.ok(envAfter.includes("KLIO_OPENROUTER_API_KEY=sk-or-x"));
});


test("runWatchTick refuses when .env is missing KLIO_JWT_SIGNING_KEY", async (t: TestCtx) => {
  // Re-rendering without the JWT key would mint a fresh placeholder
  // signing key — silently logging every user out. Better to fail
  // loudly + leave the sentinel for human inspection.
  const paths = setupKlioDir(t, {
    pending: { target_version: "0.6.1" },
    envContent: "# no JWT here\nKLIO_OPENROUTER_API_KEY=sk-or-x\n",
  });

  let calls = 0;
  const opts = makeOpts(paths, {
    composeApply: async () => {
      calls++;
    },
  });

  const result = await runWatchTick(opts);

  assert.equal(result.applied, false);
  assert.equal(result.reason, "missing-jwt-key");
  assert.equal(calls, 0, "compose must NOT run if we can't safely re-render");

  // Sentinel stays — this needs human attention (re-run klio init),
  // and removing it would mask the problem on the dashboard.
  assert.ok(existsSync(paths.pendingPath), "sentinel must persist for human inspection");
});


// --- runUpdate router integration --------------------------------


test("runUpdate --watch routes to the watcher and ticks once when bounded", async (t: TestCtx) => {
  // Routing regression test: a future refactor that accidentally
  // drops the `if (args.includes("--watch"))` branch in runUpdate
  // would let `klio update --watch` fall through to the per-slice
  // menu picker and hang waiting for stdin. We bound the watcher
  // with `watchMaxTicks: 1` so the test is deterministic.
  const paths = setupKlioDir(t, {});

  const { runUpdate } = await import("../src/commands/update.js");
  const { stdout, chunks } = captureStdout();

  await runUpdate({
    args: ["--watch"],
    stdout,
    statePath: paths.statePath,
    composeFilePath: paths.composePath,
    envPath: paths.envPath,
    composeApply: async () => {
      throw new Error("composeApply must not run when no sentinel");
    },
    watchMaxTicks: 1,
    watchIntervalSecs: 0,
  });

  const out = chunks.join("");
  assert.ok(
    out.includes("klio update --watch"),
    `expected watcher banner in stdout, got: ${out}`,
  );
});


test("runWatchTick is idempotent across rapid double-fire", async (t: TestCtx) => {
  // If the operator runs `klio update --watch` in two terminals at
  // the same time (unusual but legal), both ticks must not race in a
  // way that corrupts state.json. The second tick observes a missing
  // sentinel (the first removed it) and is a no-op.
  const paths = setupKlioDir(t, {
    pending: { target_version: "0.6.1" },
  });
  const opts = makeOpts(paths);

  const r1 = await runWatchTick(opts);
  assert.equal(r1.applied, true);

  const r2 = await runWatchTick(opts);
  assert.equal(r2.applied, false);
  assert.equal(r2.reason, "no-pending", "second tick must observe no sentinel");
});
