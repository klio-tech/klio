/**
 * `klio update --watch` — host-side watcher that consumes
 * update-pending.json sentinels written by the bridge daemon and runs
 * `docker compose pull && up -d` on the host.
 *
 * Why this exists: the bridge container has no docker CLI, and giving
 * it one would force docker-in-docker (security disaster) or mount
 * /var/run/docker.sock into the container (effectively root-on-host
 * for any code in the bridge). Splitting the apply into a "bridge
 * writes a sentinel" + "host watcher applies" pair keeps the bridge
 * confined to its own filesystem and lets the host's `klio` CLI —
 * which the user already trusts to run docker — do the privileged
 * work on the host where the docker daemon lives.
 *
 * Lifecycle:
 *   - The bridge ticker (`bridge/internal/daemon/updater_ticker.go`)
 *     writes ~/.klio/update-pending.json on every newer-version
 *     detection in apply mode.
 *   - This watcher polls the same file every WATCH_INTERVAL_SECS, and
 *     on each tick: parses the sentinel, semver-validates the target,
 *     re-renders the compose template with the new tag, runs
 *     `docker compose pull && up -d --no-deps engine bridge trust-app`,
 *     updates ~/.klio/update-state.json, and removes the sentinel.
 *   - On compose failure the sentinel STAYS so the next tick retries
 *     (handles transient docker-hub rate-limits gracefully).
 *   - On invalid sentinel (bad semver) the sentinel is REMOVED to
 *     avoid a tight retry loop on hopeless input.
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { renderComposeBody, runtimeDir } from "../compose.js";
import { resolveComposeBin, type ComposeBin } from "../docker.js";
import { parseEnvFile } from "../envFile.js";


/**
 * The default poll interval. 30 seconds is a balance: short enough
 * that an "I just clicked update now" UI surface (future v0.7.0
 * dashboard button) feels responsive, long enough that a long-
 * running watcher in a forgotten terminal doesn't spam syscalls.
 */
const DEFAULT_WATCH_INTERVAL_SECS = 30;


/**
 * Klio services the watcher recreates on apply. Mirrors
 * KLIO_SERVICES_FOR_APPLY in update-stack.ts: postgres + redis are
 * deliberately excluded because their images are pinned to upstream
 * tags (pgvector/pgvector:pg16, redis:7-alpine) that are orthogonal
 * to the @klio-tech/klio version. Touching them would force an
 * unnecessary pull and a brief data-plane interruption.
 */
const KLIO_SERVICES_FOR_APPLY = ["engine", "bridge", "trust-app"] as const;


/**
 * Strict numeric-triple semver matcher. The bridge writes a target
 * version it pulled from the npm registry, but a future writer (a
 * trust-app dashboard button, a hand-edited file by an over-curious
 * operator) might emit something else. We refuse anything other than
 * `\d+.\d+.\d+` because the value gets interpolated into a YAML body
 * that becomes a docker pull tag — both as a defence against typos
 * and against shell metacharacter injection.
 */
function isCleanSemverTriple(value: string): boolean {
  return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(value);
}


/**
 * Outcome of one watcher tick. Surfaces enough detail for the test
 * suite to discriminate between "no work", "did the work", and the
 * various failure modes — without leaking implementation specifics
 * (we never expose internal state file objects).
 */
export type WatchTickResult = {
  applied: boolean;
  /**
   * Why the tick decided what it decided. One of:
   *   - "no-pending": no sentinel on disk
   *   - "applied": sentinel was valid + compose succeeded
   *   - "invalid-target": sentinel had a non-semver target_version
   *   - "missing-jwt-key": .env had no KLIO_JWT_SIGNING_KEY
   *   - "compose-failed": docker compose pull or up returned non-zero
   *   - "parse-error": sentinel JSON was corrupt
   */
  reason:
    | "no-pending"
    | "applied"
    | "invalid-target"
    | "missing-jwt-key"
    | "compose-failed"
    | "parse-error";
  /** Target version from the sentinel — present when reason !== "no-pending". */
  targetVersion?: string;
  /** Underlying error message — present when reason names a failure. */
  errorMessage?: string;
};


export type WatchTickOptions = {
  /** Override ~/.klio. Tests use a tempdir; production uses runtimeDir(). */
  klioDir?: string;
  /** Override path to update-state.json. Defaults to <klioDir>/update-state.json. */
  statePath?: string;
  /** Override path to update-pending.json. Defaults to <klioDir>/update-pending.json. */
  pendingPath?: string;
  /** Override path to docker-compose.yml. Defaults to <klioDir>/docker-compose.yml. */
  composeFilePath?: string;
  /** Override path to .env. Defaults to <klioDir>/.env. */
  envPath?: string;
  /** Stdout for progress messages. Defaults to process.stdout. */
  stdout?: NodeJS.WritableStream;
  /**
   * Test override for the `docker compose` driver. Production shells
   * out to the real CLI; tests inject a stub that records the argv.
   * The stub returns nothing on success and throws on failure — same
   * shape as the production path.
   */
  composeApply?: (args: readonly string[]) => Promise<void>;
};


export type WatchOptions = {
  /** Forwarded into runWatchTick on each tick. */
  klioDir?: string;
  statePath?: string;
  pendingPath?: string;
  composeFilePath?: string;
  envPath?: string;
  stdout?: NodeJS.WritableStream;
  composeApply?: (args: readonly string[]) => Promise<void>;
  /** Poll interval in seconds. Defaults to DEFAULT_WATCH_INTERVAL_SECS. */
  intervalSecs?: number;
  /**
   * Test seam: when present, runWatch fires this many ticks then
   * resolves. Production callers leave it undefined so the watcher
   * runs until SIGINT. Tests use a small integer so they don't hang.
   */
  maxTicks?: number;
};


/**
 * Long-running poll loop. Production callers run this until the user
 * Ctrl-Cs. The test suite drives `runWatchTick` directly and only
 * uses this entry point for an integration-style smoke test.
 */
export async function runWatch(opts: WatchOptions): Promise<void> {
  const out = opts.stdout ?? process.stdout;
  const interval = (opts.intervalSecs ?? DEFAULT_WATCH_INTERVAL_SECS) * 1000;

  out.write(
    `klio update --watch — polling for ~/.klio/update-pending.json every ${
      opts.intervalSecs ?? DEFAULT_WATCH_INTERVAL_SECS
    }s. Press Ctrl-C to stop.\n`,
  );

  let ticksLeft = opts.maxTicks;
  let stopped = false;
  const onSig = () => {
    stopped = true;
    out.write("\nklio update --watch — stopping after current tick\n");
  };
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);

  try {
    while (!stopped) {
      await runWatchTick({
        klioDir: opts.klioDir,
        statePath: opts.statePath,
        pendingPath: opts.pendingPath,
        composeFilePath: opts.composeFilePath,
        envPath: opts.envPath,
        stdout: out,
        composeApply: opts.composeApply,
      });
      if (ticksLeft !== undefined) {
        ticksLeft -= 1;
        if (ticksLeft <= 0) break;
      }
      if (stopped) break;
      await sleep(interval);
    }
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  }
}


/**
 * Run exactly one tick of the watcher. Pure function as far as
 * outside-this-module collaborators are concerned — every side effect
 * is parameterised through opts. This is the unit-tested core; the
 * outer `runWatch` is a thin while-loop around it.
 */
export async function runWatchTick(
  opts: WatchTickOptions,
): Promise<WatchTickResult> {
  const dir = opts.klioDir ?? runtimeDir();
  const statePath = opts.statePath ?? join(dir, "update-state.json");
  const pendingPath = opts.pendingPath ?? join(dir, "update-pending.json");
  const composeFilePath =
    opts.composeFilePath ?? join(dir, "docker-compose.yml");
  const envPath = opts.envPath ?? join(dir, ".env");
  const out = opts.stdout ?? process.stdout;

  // 1. Sentinel present?
  if (!existsSync(pendingPath)) {
    return { applied: false, reason: "no-pending" };
  }

  // 2. Parse sentinel.
  let pending: { target_version?: string };
  try {
    pending = JSON.parse(readFileSync(pendingPath, "utf8")) as {
      target_version?: string;
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.write(
      `klio update --watch: corrupt update-pending.json: ${message}\n`,
    );
    persistApplyError(statePath, `parse update-pending.json: ${message}`);
    // Remove the corrupt sentinel — leaving it would jam every tick.
    safeUnlink(pendingPath);
    return { applied: false, reason: "parse-error", errorMessage: message };
  }
  const targetVersion = pending.target_version ?? "";

  // 3. Validate target_version. Refusing here is the only thing
  //    standing between a hand-edited `update-pending.json` and a
  //    `docker pull klio-engine:; rm -rf /:0.0.0` shell-injection
  //    attempt. We also remove the sentinel — leaving it would loop.
  if (!isCleanSemverTriple(targetVersion)) {
    const message = `invalid target_version: ${JSON.stringify(targetVersion)}`;
    out.write(`klio update --watch: ${message}\n`);
    persistApplyError(statePath, message);
    safeUnlink(pendingPath);
    return {
      applied: false,
      reason: "invalid-target",
      targetVersion,
      errorMessage: message,
    };
  }

  // 4. Recover JWT signing key. Without it, the re-render would mint
  //    a fresh placeholder key — silently logging every user out.
  //    Leave the sentinel for human inspection.
  const env = parseEnvFile(envPath);
  const jwtKey = env.KLIO_JWT_SIGNING_KEY;
  if (!jwtKey || jwtKey.length === 0) {
    const message =
      "~/.klio/.env missing KLIO_JWT_SIGNING_KEY — re-run `klio init`";
    out.write(`klio update --watch: ${message}\n`);
    persistApplyError(statePath, message);
    return {
      applied: false,
      reason: "missing-jwt-key",
      targetVersion,
      errorMessage: message,
    };
  }

  // 5. Re-render compose. Mirrors update-stack.ts's --to-version
  //    flow: every klio image:tag in the YAML pins to targetVersion,
  //    every other key is preserved.
  out.write(
    `klio update --watch: applying ${targetVersion} (re-rendering compose)\n`,
  );
  const body = renderComposeBody({
    imageTag: targetVersion,
    jwtSigningKey: jwtKey,
    embeddingModel: env.KLIO_EMBEDDING_MODEL ?? "openrouter/openai/text-embedding-3-small",
    extractionModel: env.KLIO_EXTRACTION_MODEL ?? "openrouter/anthropic/claude-3-5-haiku",
  });
  writeFileSync(composeFilePath, body, { mode: 0o600 });

  // 6. Run pull + up. Failure here is RECOVERABLE — keep the sentinel
  //    so the next tick retries (transient docker-hub rate-limits).
  const apply = opts.composeApply ?? defaultComposeApply(composeFilePath);
  try {
    out.write(`klio update --watch: docker compose pull\n`);
    await apply(["pull"]);
    out.write(
      `klio update --watch: docker compose up -d --no-deps ${KLIO_SERVICES_FOR_APPLY.join(" ")}\n`,
    );
    await apply([
      "up",
      "-d",
      "--no-deps",
      ...KLIO_SERVICES_FOR_APPLY,
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.write(`klio update --watch: compose failed: ${message}\n`);
    persistApplyError(statePath, message);
    return {
      applied: false,
      reason: "compose-failed",
      targetVersion,
      errorMessage: message,
    };
  }

  // 7. Success. Update state.json + remove sentinel.
  persistApplySuccess(statePath, targetVersion);
  safeUnlink(pendingPath);
  out.write(`✓ klio update --watch: applied ${targetVersion}\n`);
  return { applied: true, reason: "applied", targetVersion };
}


// --- Helpers ------------------------------------------------------


/**
 * Default `composeApply` — shells out to `docker compose -f <file>
 * <args...>` with stdout/stderr piped through. Matches update-stack.ts's
 * `defaultComposeApply` so the watcher and `klio update --to-version`
 * present a consistent UX (chatty pull progress, real-time creates).
 */
function defaultComposeApply(
  composeFilePath: string,
): (args: readonly string[]) => Promise<void> {
  return async (args) => {
    const cwd = composeFileDir(composeFilePath);
    const bin: ComposeBin = await resolveComposeBin();
    return new Promise((resolve, reject) => {
      const argv = [
        ...bin.prefix,
        "-f",
        composeFilePath,
        ...args,
      ];
      const child = spawn(bin.cmd, argv, {
        cwd,
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(`${bin.cmd} ${argv.join(" ")} exited ${code}`),
          );
      });
    });
  };
}


function composeFileDir(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? "." : filePath.slice(0, idx) || "/";
}


/**
 * Read state.json, mutate, write back. The watcher is the host-side
 * authority for last_applied_*; the bridge writes
 * last_known_available_version + last_check_*. Both writers atomically
 * replace the file (writeFileSync on the same path) so a concurrent
 * reader observes either the pre or post state in full.
 */
type StateLike = {
  current_version?: string;
  last_check_at?: string;
  last_check_error?: string;
  last_known_available_version?: string;
  last_applied_version?: string;
  last_applied_at?: string;
  last_apply_error?: string;
};


function persistApplySuccess(statePath: string, targetVersion: string): void {
  const state = readState(statePath);
  state.current_version = targetVersion;
  state.last_applied_version = targetVersion;
  state.last_applied_at = new Date().toISOString();
  // Clear the error fields — we just succeeded, anything stale is
  // misleading.
  delete state.last_apply_error;
  writeState(statePath, state);
}


function persistApplyError(statePath: string, message: string): void {
  const state = readState(statePath);
  state.last_apply_error = message;
  writeState(statePath, state);
}


function readState(statePath: string): StateLike {
  if (!existsSync(statePath)) return {};
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as StateLike;
  } catch {
    // Corrupt state file — start fresh. The bridge ticker rewrites it
    // every tick, so any data we drop here is recoverable.
    return {};
  }
}


/**
 * Atomically replace the state file. Matches the bridge's
 * `updater.Write` semantics (write to a sibling .tmp, rename) so a
 * concurrent reader — including the bridge ticker — never observes a
 * partially-written state.json.
 *
 * Why this matters: the bridge ticks every 6h and writes
 * `last_check_at` / `last_known_available_version`; the watcher ticks
 * every 30s and writes `last_applied_*`. They overlap in the steady
 * state. Without atomicity a concurrent bridge writer + watcher
 * read-mutate-write could lose either side's update.
 */
function writeState(statePath: string, state: StateLike): void {
  const body = JSON.stringify(state, null, 2) + "\n";
  // Same-directory tmp file → rename is atomic on POSIX (and on
  // Windows it's at least a single syscall, which is the closest the
  // platform offers without going to a transactional FS).
  //
  // We use a random suffix (instead of a constant ".tmp") so two
  // concurrent watchers don't clobber each other mid-write — the
  // operator running `klio update --watch` in two terminals is rare
  // but legal, and "safe in that case" is cheaper than "documents
  // why you can't".
  const tmpPath = `${statePath}.${randomBytes(6).toString("hex")}.tmp`;
  let renamed = false;
  try {
    writeFileSync(tmpPath, body, { mode: 0o644 });
    renameSync(tmpPath, statePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* nothing to clean */
      }
    }
  }
}


function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // Best-effort: log but don't crash. The next tick will retry.
      process.stderr.write(
        `klio update --watch: failed to remove ${path}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
