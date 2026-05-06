/**
 * `klio update` — re-run a slice of init without rebuilding the
 * whole stack.
 *
 * Subcommands:
 *   `klio update`          — menu picker over the three slices
 *   `klio update curator`  — re-prompt curator schedule + model
 *   `klio update agents`   — re-detect + re-wire AI agents
 *   `klio update provider` — change LLM provider without re-init
 *
 * E1 wired the routing skeleton + menu picker. E2 fleshes out
 * `runUpdateCurator`. The `--run-now` flag arrives in E5.
 */

import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import { spawn } from "node:child_process";

import { runtimeDir } from "../compose.js";
import {
  CURATOR_CADENCE_LABELS,
  type CuratorCadence,
} from "../curatorConfig.js";
import {
  composeUpService,
  resolveComposeBin,
  type ComposeBin,
} from "../docker.js";
import { allAdapters } from "../adapters/types.js";
import { mergeEnvFile, parseEnvFile } from "../envFile.js";
import { prefixEmbeddingModel, prefixModel } from "../modelRouting.js";
import { prompt } from "../prompt.js";
import {
  runProviderStep as defaultRunProviderStep,
  type ProviderResult,
} from "./providerStep.js";
import {
  runUpdateCheck,
  runUpdateToLatest,
  runUpdateToVersion,
} from "./update-stack.js";
import {
  wireDetectedAgents,
  type WireAgentsResult,
} from "./wireAgents.js";

/**
 * Container the bridge runs under — must match `BRIDGE_CONTAINER`
 * in `init.ts`. Duplicated as a module-private constant rather
 * than imported because exporting it from init.ts would drag the
 * whole init module (and its transitive deps) into update's
 * import graph; a future refactor that lifts the value into a
 * shared `constants.ts` is cheap, but not in scope for E3.
 */
const BRIDGE_CONTAINER = "klio-bridge";


export type UpdateTarget = "menu" | "curator" | "agents" | "provider" | "unknown";


/** Parse the residual argv after `klio update`. */
export function parseUpdateTarget(args: readonly string[]): UpdateTarget {
  if (args.length === 0) return "menu";
  const first = args[0];
  if (first === "curator" || first === "agents" || first === "provider") {
    return first;
  }
  return "unknown";
}


/**
 * Hook seam used by tests. Production callers leave every field
 * undefined and fall back to real I/O + a real `docker compose`.
 *
 * Why a struct rather than module-level mocking: the npm package
 * publishes plain ESM and avoids any runtime dependency, so the
 * test suite can't reach for jest-style auto-mocks. Threading the
 * collaborators through the call signature keeps the production
 * code clean and the test path explicit.
 */
export type UpdateOptions = {
  /** Residual argv after `klio update` (e.g. ["curator", "--run-now"]). */
  args: readonly string[];
  /** Override the path to the env file. Defaults to ~/.klio/.env. */
  envPath?: string;
  /** Override the compose file path. Defaults to ~/.klio/docker-compose.yml. */
  composeFilePath?: string;
  /** Stdin override forwarded to interactive prompts. Defaults to process.stdin. */
  stdin?: Readable;
  /** Stdout override forwarded to interactive prompts. Defaults to process.stdout. */
  stdout?: Writable;
  /**
   * Custom restart hook — called after the env file has been
   * rewritten. The default implementation runs
   * `docker compose -f <compose> up -d --no-deps engine`. Tests
   * pass a no-op so they don't shell out to docker.
   */
  restartEngine?: () => Promise<void>;
  /**
   * Override the provider-selection step. Defaults to the shared
   * `runProviderStep` from `./providerStep.js`, which drives the
   * full provider menu + setup loop (network probes, Ollama
   * detection, custom-endpoint validation). Tests inject a stub
   * that returns a synthetic `ProviderResult` so the suite never
   * touches readline or the network.
   */
  runProviderStep?: () => Promise<ProviderResult>;
  /**
   * Override the `--run-now` exec hook. When `klio update curator
   * --run-now` is invoked, the npm CLI asks the bridge container
   * (which holds the user's bearer token — the npm side does not)
   * to issue `POST /v1/curator/run-now` against the engine on the
   * user's behalf. The contract: `docker exec klio-bridge klio
   * curator run-now`.
   *
   * Tests inject a stub that records the argv and returns a
   * synthetic `RunNowResult` so the suite never shells out to
   * docker. Production callers leave this undefined and get the
   * default `dockerExecCapture` implementation that wraps
   * `docker exec` and returns the captured streams.
   *
   * Why a hook seam rather than calling `dockerExec` directly: the
   * existing `dockerExec` helper THROWS on non-zero exit. The
   * run-now path needs to inspect a non-zero exit (bridge too old,
   * engine still booting, etc.) and degrade gracefully — so it
   * needs the captured-streams shape, not the throw-on-failure one.
   */
  runNowExec?: (argv: readonly string[]) => Promise<RunNowResult>;
  /**
   * Test override for `fetch`. v0.6.0 `--check` / `--to-latest` hit
   * the npm registry; production uses the global `fetch`, tests
   * inject a stub that returns a canned `{ version }` payload so
   * the suite never touches the network.
   */
  fetchFn?: typeof fetch;
  /**
   * Test override for the path to the bridge-written update-state
   * file. Defaults to `<runtimeDir()>/update-state.json` (i.e.
   * ~/.klio/update-state.json on the host, mounted at /host/.klio
   * inside the bridge container). The npm CLI only READS this file
   * — the bridge ticker is the sole writer.
   */
  statePath?: string;
  /**
   * Test override for the stack-wide compose driver used by
   * `--to-version` / `--to-latest`. Production shells out to
   * `docker compose -f <file> <args...>`. Tests inject a stub that
   * records the argv so we can assert on `pull` + `up -d --no-deps
   * engine bridge trust-app` without touching the user's daemon.
   */
  composeApply?: (args: readonly string[]) => Promise<void>;
};


/**
 * Captured-streams result from a `--run-now` docker exec. Unlike
 * the rest of the npm package's docker helpers (which throw on
 * non-zero exit), the run-now path treats failure as a soft signal:
 * the env file is already saved and the engine is already restarted
 * before this hook fires, so a docker-exec failure is purely an
 * informational miss for the user — not a fatal CLI error.
 */
export type RunNowResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};


export async function runUpdate(opts: UpdateOptions): Promise<void> {
  // v0.6.0 stack-wide flags. These short-circuit the curator/agents/
  // provider menu — they upgrade the whole stack, not a single slice,
  // so they're conceptually distinct from the per-slice subtargets
  // even though they share the `klio update` verb. The flags must
  // be intercepted BEFORE `parseUpdateTarget`, which would otherwise
  // reject them as "unknown" subtargets.
  const args = opts.args;
  if (args.includes("--check")) {
    return runUpdateCheck(opts);
  }
  if (args.includes("--to-latest")) {
    return runUpdateToLatest(opts);
  }
  const toVersionIdx = args.indexOf("--to-version");
  if (toVersionIdx >= 0) {
    const version = args[toVersionIdx + 1];
    if (version === undefined || version.startsWith("--")) {
      process.stderr.write(
        "klio update --to-version: missing version argument\n",
      );
      process.exit(2);
    }
    return runUpdateToVersion(opts, version as string);
  }

  const target = parseUpdateTarget(opts.args);

  if (target === "unknown") {
    process.stderr.write(
      `klio update: unknown target ${JSON.stringify(opts.args[0])}\n` +
        `Valid targets: curator, agents, provider, or no argument for menu.\n`,
    );
    process.exit(1);
  }

  const resolved = target === "menu" ? await pickFromMenu(opts) : target;
  if (resolved === null) {
    process.stdout.write("Cancelled.\n");
    return;
  }

  switch (resolved) {
    case "curator":
      await runUpdateCurator(opts);
      return;
    case "agents":
      await runUpdateAgents(opts);
      return;
    case "provider":
      await runUpdateProvider(opts);
      return;
  }
}


/** Show the four-option picker. Returns the chosen target or null on cancel. */
async function pickFromMenu(
  opts: UpdateOptions,
): Promise<"curator" | "agents" | "provider" | null> {
  const out = opts.stdout ?? process.stdout;
  out.write(
    "\nWhat would you like to change?\n" +
      "  1) Provider + model picks\n" +
      "  2) Curator schedule + model\n" +
      "  3) Re-wire AI agents (re-runs adapter detection)\n" +
      "  4) Cancel\n",
  );
  const answer = await prompt({
    message: "Choice",
    default: "1",
    stdin: opts.stdin,
    stdout: opts.stdout,
  });
  const trimmed = answer.trim();
  switch (trimmed) {
    case "1":
    case "":
      return "provider";
    case "2":
      return "curator";
    case "3":
      return "agents";
    case "4":
      return null;
    default:
      process.stderr.write(
        `Unknown choice ${JSON.stringify(trimmed)} — cancelling.\n`,
      );
      return null;
  }
}


// --- Block bodies -------------------------------------------------


/**
 * `klio update curator` — re-prompt for cadence + model and
 * persist the change.
 *
 * Flow:
 *   1. Read ~/.klio/.env to recover the user's current curator
 *      settings (treat absent values as the engine's defaults).
 *   2. Show a "Current: ..." header so the user sees what they're
 *      about to change.
 *   3. Schedule picker (5 cadences + "disable"), defaulting to the
 *      current selection.
 *   4. Model picker — option 1 reuses the user's extraction model
 *      (the engine's `effective_curator_model` resolves the empty
 *      string to KLIO_EXTRACTION_MODEL server-side). Option 2 lets
 *      them type a custom routing-shape model id.
 *   5. Merge the new {enabled, cadence, model} triple into .env
 *      preserving every other key.
 *   6. Re-create the engine container so the new env vars take
 *      effect — `restart` doesn't re-read .env, only `up -d` does.
 */
async function runUpdateCurator(opts: UpdateOptions): Promise<void> {
  const out = opts.stdout ?? process.stdout;
  const envPath = opts.envPath ?? join(runtimeDir(), ".env");
  const env = parseEnvFile(envPath);

  // Decode current state from the env file.
  const currentCadence = inferCadence(env);
  const currentModel = env.KLIO_CURATOR_MODEL ?? "";
  const currentLabel =
    CURATOR_CADENCE_LABELS.find((c) => c.slug === currentCadence)?.label ??
    currentCadence;

  out.write(
    `\nCurrent: ${currentLabel}, ${
      currentModel === "" ? "(extraction model)" : currentModel
    }\n\n`,
  );

  // Schedule picker.
  out.write("  Schedule\n");
  const currentIdx = CURATOR_CADENCE_LABELS.findIndex(
    (c) => c.slug === currentCadence,
  );
  for (let i = 0; i < CURATOR_CADENCE_LABELS.length; i++) {
    const c = CURATOR_CADENCE_LABELS[i];
    const star = c.slug === currentCadence ? " ★ current" : "";
    out.write(`    ${i + 1}) ${c.label}${star}\n`);
  }
  const defaultCadenceChoice = String(Math.max(currentIdx, 0) + 1);
  const cadenceAnswer = await prompt({
    message: "Choice",
    default: defaultCadenceChoice,
    stdin: opts.stdin,
    stdout: opts.stdout,
    validate: (v) => validateCadenceChoice(v),
  });
  const cadenceIdx = Number(cadenceAnswer.trim()) - 1;
  const newCadence: CuratorCadence = CURATOR_CADENCE_LABELS[cadenceIdx].slug;

  // Model picker.
  out.write("\n  Model\n");
  out.write("    1) same as extraction model ★ current\n");
  out.write("    2) pick a different one\n");
  const modelAnswer = await prompt({
    message: "Choice",
    default: "1",
    stdin: opts.stdin,
    stdout: opts.stdout,
    validate: (v) => (v === "1" || v === "2" ? null : "enter 1 or 2"),
  });
  let newModel = "";
  if (modelAnswer.trim() === "2") {
    const free = await prompt({
      message: "Model",
      default: currentModel === "" ? undefined : currentModel,
      stdin: opts.stdin,
      stdout: opts.stdout,
    });
    newModel = free.trim();
  }

  const enabled = newCadence !== "disabled";
  const intervalSecs = CURATOR_CADENCE_LABELS.find(
    (c) => c.slug === newCadence,
  )!.intervalSecs;

  // Targeted-replace: every non-curator key (JWT signing key,
  // OpenRouter creds, user/agent UUIDs, …) is preserved by
  // `mergeEnvFile`.
  mergeEnvFile(envPath, {
    KLIO_CURATOR_ENABLED: enabled ? "true" : "false",
    KLIO_CURATOR_INTERVAL_SECS: String(intervalSecs),
    KLIO_CURATOR_MODEL: newModel,
  });

  out.write("\n  ✓ Saved. Restarting engine to apply…\n");

  const restart = opts.restartEngine ?? defaultRestartEngine(opts);
  await restart();

  // `--run-now` post-step. Strictly opt-in: the flag has to be in
  // argv. We intentionally do NOT trigger this on every curator
  // update — the schedule picker offering "every 5 minutes" already
  // gives the user a near-immediate cadence. The flag is for the
  // "disabled" / "on-demand" cadence, where the timer won't fire and
  // the user wants the queued backlog to drain right now.
  if (hasRunNowFlag(opts.args)) {
    await invokeRunNow(opts, out);
  }
}


/** True iff `--run-now` appears anywhere in the residual argv. */
function hasRunNowFlag(args: readonly string[]): boolean {
  // Accept the GNU-long form only. Single-letter shortcuts are
  // reserved — `--run-now` is unambiguous and self-documenting in
  // shell history (`klio update curator --run-now`).
  return args.includes("--run-now");
}


/**
 * Drive the `--run-now` post-step. Calls into the user-supplied or
 * default `runNowExec`, prints a short status line, and intentionally
 * SWALLOWS non-zero exits — by the time this runs, the env was saved
 * and the engine was re-created, so the curator settings change has
 * fully landed. A failed run-now is a convenience miss, not a fatal
 * CLI error.
 *
 * Failure modes we expect:
 *   - Bridge container's `klio` binary is too old to recognise the
 *     `curator run-now` subcommand (typical first time the user
 *     upgrades the npm package without bouncing the bridge).
 *   - Engine still booting after the `up -d --no-deps engine` we
 *     just issued (the bridge will get a connection refused). The
 *     user can re-issue the flag manually after a few seconds, or
 *     wait for the timer if they re-enabled cadence.
 *   - Auth token revoked / expired. The bridge prints a token error
 *     to stderr; we surface it verbatim so the user can act.
 *
 * In all cases the contract is: the run-now is best-effort, never
 * blocks success of the underlying settings change.
 */
async function invokeRunNow(
  opts: UpdateOptions,
  out: Writable,
): Promise<void> {
  out.write("\n  Triggering an immediate curator pass…\n");

  const exec = opts.runNowExec ?? defaultRunNowExec();
  const argv = ["exec", "-i", BRIDGE_CONTAINER, "klio", "curator", "run-now"];

  let result: RunNowResult;
  try {
    result = await exec(argv);
  } catch (err) {
    // Hook itself blew up — surface the message but don't fail the
    // command. Treat the same as a non-zero exit.
    const message = err instanceof Error ? err.message : String(err);
    out.write(`  ! Run-now skipped: ${message}\n`);
    return;
  }

  if (result.exitCode === 0) {
    // Stream the bridge's stdout straight through; the bridge prints
    // a one-line summary suitable for human consumption.
    const trimmed = result.stdout.trim();
    if (trimmed.length > 0) {
      out.write(`  ${trimmed}\n`);
    } else {
      out.write("  ✓ Run-now dispatched.\n");
    }
    return;
  }

  // Non-zero exit. Most common case is the bridge being older than
  // the npm package — the bridge will print "unknown subcommand:
  // curator" to stderr. We surface a single, friendly line so the
  // user knows what happened without a stack trace.
  const stderr = result.stderr.trim();
  if (stderr.length > 0) {
    out.write(
      `  ! Run-now skipped (bridge exit ${result.exitCode}): ${stderr}\n`,
    );
  } else {
    out.write(`  ! Run-now skipped (bridge exit ${result.exitCode}).\n`);
  }
}


/**
 * Default `runNowExec` — wraps `docker exec` and returns the
 * captured streams. Distinct from `dockerExec` in `../docker.ts`
 * which throws on non-zero exit; the run-now path needs to inspect
 * a non-zero exit (bridge too old, engine still booting) and
 * degrade gracefully.
 */
function defaultRunNowExec(): (
  argv: readonly string[],
) => Promise<RunNowResult> {
  return (argv) =>
    new Promise<RunNowResult>((resolve, reject) => {
      const child = spawn("docker", [...argv], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      // `error` fires when the binary itself can't be spawned (e.g.
      // docker not on PATH). Caller's try/catch turns that into a
      // friendly skip line.
      child.on("error", reject);
      child.on("exit", (code) => {
        resolve({ exitCode: code ?? 0, stdout, stderr });
      });
    });
}


/** Map current env into a cadence slug. Defaults to "hourly". */
function inferCadence(env: Record<string, string>): CuratorCadence {
  if (env.KLIO_CURATOR_ENABLED === "false") return "disabled";
  const seconds = Number(env.KLIO_CURATOR_INTERVAL_SECS ?? "3600");
  if (!Number.isFinite(seconds)) return "hourly";
  const match = CURATOR_CADENCE_LABELS.find(
    (c) => c.intervalSecs === seconds && c.slug !== "disabled",
  );
  return match?.slug ?? "hourly";
}


/** Validator for the schedule picker — accept 1..N as the choice. */
function validateCadenceChoice(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null; // default kicks in
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > CURATOR_CADENCE_LABELS.length) {
    return `enter 1-${CURATOR_CADENCE_LABELS.length}`;
  }
  return null;
}


/**
 * Default engine-restart hook: shells out to `docker compose up -d
 * --no-deps engine`. Tests inject their own no-op via
 * `opts.restartEngine`.
 */
function defaultRestartEngine(opts: UpdateOptions): () => Promise<void> {
  return async () => {
    const composeFile =
      opts.composeFilePath ?? join(runtimeDir(), "docker-compose.yml");
    const bin: ComposeBin = await resolveComposeBin();
    // composeUpService runs in a working directory; pass the
    // compose file's directory so `docker compose` discovers the
    // .env sibling automatically.
    const cwd = composeFileDir(composeFile);
    await composeUpService(bin, cwd, "engine");
  };
}


function composeFileDir(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? "." : filePath.slice(0, idx) || "/";
}


/**
 * `klio update agents` — re-run adapter detection and re-wire any
 * detected AI agent's MCP config. Recovery path for users whose
 * Phase 4 confirmation went sideways during init (the 0.4.1 bug
 * where memory text typed at the prompt skipped every adapter).
 *
 * Delegates to `wireDetectedAgents`, the shared helper init's
 * Phase 4 also calls — so any future hardening there (new adapter
 * added to `allAdapters()`, tighter confirm UX) is picked up by
 * this entry point automatically.
 *
 * Engine restart is intentionally NOT performed: re-wiring touches
 * agent-side config files (~/.claude.json, ~/.cursor/mcp.json,
 * etc.), not engine env vars. The user reloads their agent on the
 * next session and the new MCP server entry is live.
 */
async function runUpdateAgents(opts: UpdateOptions): Promise<void> {
  const out = opts.stdout ?? process.stdout;
  const log = (line: string): void => {
    out.write(line + "\n");
  };

  out.write("\nRe-detecting AI agents and re-wiring MCP configs…\n");

  const result = await wireDetectedAgents({
    bridgeContainer: BRIDGE_CONTAINER,
    env: {},
    log,
  });

  if (result.skipped && result.configured.length === 0 && result.errored.length === 0) {
    if (allAdaptersUndetected(result)) {
      out.write(
        "\n  No supported AI agents detected. Install Claude Code, Claude Desktop, " +
          "Cursor, Codex, OpenCode, or OpenClaw and re-run `klio update agents`.\n",
      );
      return;
    }
    out.write("\n  Skipped — re-run `klio update agents` to wire them.\n");
    return;
  }

  for (const e of result.errored) {
    process.stderr.write(`! ${e.name}: ${e.message}\n`);
  }
  out.write("\n  Done.\n");
}


/**
 * Distinguish the two "skipped" sub-cases. `wireDetectedAgents`
 * returns `skipped: true, configured: [], errored: []` for BOTH
 * "no agents on host" and "user said no at the confirm". The
 * difference matters for the recovery copy: an empty host gets
 * the install hint; a declined confirm gets the re-run hint.
 *
 * The signal we use: when the helper printed nothing past the
 * leading newline (no "Found:" line), the host is empty. Our
 * proxy is `result.errored.length === 0` AND `result.configured
 * .length === 0` — already true at the call site — combined with
 * the absence of any `notFound` info we could re-derive. To keep
 * this honest without re-running detection, we re-check
 * `allAdapters()` ourselves.
 */
function allAdaptersUndetected(_: WireAgentsResult): boolean {
  // Re-check directly. `installed()` is a pure host-fs lookup so
  // running it twice in this command is cheap and avoids leaking
  // detection state through the helper's return shape.
  return allAdapters().every((a) => !a.installed());
}


/**
 * `klio update provider` — re-run the provider-selection flow init's
 * Phase 2 uses, persist the new env values, and restart the engine
 * so the new model picks take effect.
 *
 * Flow:
 *   1. Prologue copy so the user knows the existing model picks are
 *      about to be replaced.
 *   2. Drive `runProviderStep` (shared with init Phase 2) — full
 *      menu + provider-specific setup loop with live probes.
 *   3. Translate the resulting `ProviderResult` into the engine's
 *      env-var shape via `buildProviderEnvUpdates`. The shape mirrors
 *      what init.ts's `buildEnvVars` writes:
 *        - openrouter → KLIO_OPENROUTER_API_KEY filled, other
 *          provider keys blanked.
 *        - ollama     → no upstream key needed; OPENROUTER + CUSTOM
 *          slots blanked so a previous provider's stale creds don't
 *          ride along.
 *        - custom     → KLIO_CUSTOM_BASE_URL + KLIO_CUSTOM_API_KEY
 *          filled, OPENROUTER blanked.
 *   4. `mergeEnvFile` preserves every non-provider key (JWT, user/
 *      agent UUIDs, curator block, etc.) and surgically replaces
 *      the provider slot.
 *   5. Restart the engine via the shared compose-up hook so the new
 *      env vars take effect — `restart` doesn't re-read .env, only
 *      `up -d` does.
 *
 * The Ollama branch's setup helper may return a fallback sentinel
 * (no daemon, no embed model, etc.); that recovery path is fully
 * handled inside `runProviderStep`, so this function's contract is
 * "always returns a populated ProviderResult or throws". Throws
 * propagate to the CLI top-level handler.
 */
async function runUpdateProvider(opts: UpdateOptions): Promise<void> {
  const out = opts.stdout ?? process.stdout;
  const log = (line: string): void => {
    out.write(line + "\n");
  };

  out.write(
    "\nRe-running provider setup. Existing model picks will be replaced.\n",
  );

  const stepFn = opts.runProviderStep ?? (() => defaultRunProviderStep({ log }));
  const provider = await stepFn();

  const envPath = opts.envPath ?? join(runtimeDir(), ".env");
  const updates = buildProviderEnvUpdates(provider);

  // Targeted-replace: every non-provider key (JWT signing key, user/
  // agent UUIDs, curator block, log level) is preserved by
  // `mergeEnvFile`. Stale provider keys belonging to the OLD provider
  // are blanked here (rather than left dangling) so a switch from
  // openrouter → ollama doesn't leave the engine with a hot OpenRouter
  // key it can't actually reach the chosen Ollama model with.
  mergeEnvFile(envPath, updates);

  out.write("\n  ✓ Saved. Restarting engine to apply…\n");

  const restart = opts.restartEngine ?? defaultRestartEngine(opts);
  await restart();
}


/**
 * Translate a `ProviderResult` into the engine's env-var shape. The
 * caller hands the result to `mergeEnvFile`, so every key here lands
 * verbatim into ~/.klio/.env.
 *
 * Three slots always get a value (possibly the empty string):
 *   - KLIO_OPENROUTER_API_KEY — only populated for openrouter.
 *   - KLIO_CUSTOM_BASE_URL    — only populated for custom.
 *   - KLIO_CUSTOM_API_KEY     — only populated for custom.
 *
 * Empty-string writes (rather than key omission) are deliberate: they
 * blank stale credentials from a previous provider so the engine
 * can't dispatch to an upstream the user just abandoned. The engine's
 * router treats an empty `KLIO_OPENROUTER_API_KEY` as "OpenRouter
 * disabled", same as the absent-key case.
 *
 * `KLIO_EMBEDDING_MODEL` goes through `prefixEmbeddingModel` (strips
 * Ollama tags — the engine's embedding registry keys by bare name);
 * `KLIO_EXTRACTION_MODEL` keeps its tag because chat dispatch passes
 * the tag straight to the upstream backend (qwen2.5:7b-instruct vs
 * qwen2.5:1.5b are different model weights).
 */
export function buildProviderEnvUpdates(
  provider: ProviderResult,
): Record<string, string> {
  const updates: Record<string, string> = {
    KLIO_OPENROUTER_API_KEY: "",
    KLIO_CUSTOM_BASE_URL: "",
    KLIO_CUSTOM_API_KEY: "",
    KLIO_EMBEDDING_MODEL:
      prefixEmbeddingModel(provider.kind, provider.config.embeddingModel) ?? "",
    KLIO_EXTRACTION_MODEL:
      prefixModel(provider.kind, provider.config.extractionModel) ?? "",
    KLIO_EMBEDDING_DIM: String(provider.config.embeddingDim),
  };

  if (provider.kind === "openrouter") {
    updates.KLIO_OPENROUTER_API_KEY = provider.config.openrouterKey;
  } else if (provider.kind === "custom") {
    updates.KLIO_CUSTOM_BASE_URL = provider.config.baseUrl;
    updates.KLIO_CUSTOM_API_KEY = provider.config.apiKey;
  }
  // ollama: nothing else to inject — host-network access via
  // host.docker.internal is configured by the compose template.

  return updates;
}


// Re-exported for testing — the curator-update flow is the unit
// under test, but parseUpdateTarget already had its tests in E1.
export { runUpdateCurator };
