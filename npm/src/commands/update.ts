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
import { mergeEnvFile, parseEnvFile } from "../envFile.js";
import { prompt } from "../prompt.js";


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
};


export async function runUpdate(opts: UpdateOptions): Promise<void> {
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


async function runUpdateAgents(_opts: UpdateOptions): Promise<void> {
  process.stdout.write(
    "klio update agents: not yet implemented (lands in v0.5.0 / Task E3).\n",
  );
}


async function runUpdateProvider(_opts: UpdateOptions): Promise<void> {
  process.stdout.write(
    "klio update provider: not yet implemented (lands in v0.5.0 / Task E4).\n",
  );
}


// Re-exported for testing — the curator-update flow is the unit
// under test, but parseUpdateTarget already had its tests in E1.
export { runUpdateCurator };
