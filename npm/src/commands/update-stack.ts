/**
 * v0.6.0 stack-wide update flags — `klio update --check`,
 * `--to-latest`, and `--to-version <X>`. These short-circuit the
 * v0.5.0 per-slice menu (curator/agents/provider) because they
 * upgrade the entire klio image set rather than tweaking a single
 * slice of config.
 *
 * This module is the user-facing affordance for the auto-update
 * lifecycle whose server-side machinery lives in
 * `bridge/internal/updater`. The bridge ticker writes
 * ~/.klio/update-state.json on every check; the CLI reads that file
 * (read-only — bridge owns writes) plus the npm registry to surface
 * a friendly diff. The apply path re-renders the compose template
 * with the new image tag and shells out to `docker compose pull &&
 * up -d --no-deps engine bridge trust-app`.
 *
 * Why a separate module from `update.ts`: keeps the per-slice flow
 * (which is dense — interactive prompts, env-merge, restart) and
 * the stack-wide flow visually distinct. update.ts already pushes
 * the user-suggested 800-line guideline; siphoning the v0.6.0
 * additions here keeps each module focused.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { runtimeDir, writeComposeFile } from "../compose.js";
import { resolveComposeBin, type ComposeBin } from "../docker.js";
import { parseEnvFile } from "../envFile.js";
import { packageVersion } from "../version.js";


/**
 * The npm registry endpoint that publishes the `latest`-tagged
 * version of `@klio-tech/klio`. Mirrors `bridge/internal/updater`'s
 * `NpmRegistryURL` constant — both the bridge ticker and the CLI
 * consult the same upstream so users see consistent values.
 */
const NPM_LATEST_URL = "https://registry.npmjs.org/@klio-tech/klio/latest";


/**
 * Klio services the v0.6.0 stack-wide update flow recreates. Postgres
 * and Redis are deliberately excluded — their images are pinned to
 * upstream tags (pgvector/pgvector:pg16, redis:7-alpine) that don't
 * track the @klio-tech/klio version. Touching them would force an
 * unnecessary pull and a brief data-plane interruption for what is,
 * by definition, only a klio-image rev.
 */
export const KLIO_SERVICES_FOR_APPLY: readonly string[] = [
  "engine",
  "bridge",
  "trust-app",
];


/**
 * The slice of UpdateOptions this module needs. Defined narrowly
 * (rather than re-importing the full UpdateOptions) so the dependency
 * direction stays update.ts → update-stack.ts and never the reverse.
 */
export type StackUpdateOptions = {
  args: readonly string[];
  envPath?: string;
  composeFilePath?: string;
  stdout?: NodeJS.WritableStream;
  /** Test override for fetch. Production uses global fetch. */
  fetchFn?: typeof fetch;
  /** Test override for state file path. Production uses ~/.klio/update-state.json. */
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
 * `klio update --check` — print the running version vs the latest
 * published @klio-tech/klio version. Pure read-only: never touches
 * the .env, the compose file, or the docker daemon.
 *
 * Resolution order for "current":
 *   1. ~/.klio/update-state.json — written by the bridge ticker on
 *      every check, so this is the freshest source of truth on a
 *      host where the bridge has run at least once.
 *   2. The CLI's own package.json version — the npm package the user
 *      invoked. Used when the bridge ticker has never run (state file
 *      absent) so the user still gets a useful diff.
 *
 * Network failure surfaces as a non-zero exit: a `klio update --check`
 * that silently lies about being up-to-date would mask the upgrade
 * path. We prefer a loud, actionable error.
 */
export async function runUpdateCheck(
  opts: StackUpdateOptions,
): Promise<void> {
  const out = opts.stdout ?? process.stdout;
  const fetchFn = opts.fetchFn ?? fetch;
  const statePath = opts.statePath ?? join(runtimeDir(), "update-state.json");

  const currentVersion = readCurrentVersion(statePath);

  out.write(
    "Checking npm registry for the latest @klio-tech/klio version…\n",
  );
  const latest = await fetchLatestVersion(fetchFn, "klio update --check");

  out.write(`Current: ${currentVersion}\n`);
  out.write(`Latest:  ${latest}\n`);
  if (currentVersion === latest) {
    out.write("✓ You're on the latest.\n");
  } else {
    out.write(
      "→ Newer version available. Run `klio update --to-latest` to apply.\n",
    );
  }
}


/**
 * `klio update --to-latest` — resolve the latest npm version and
 * apply it. Implementation is `--check` + `--to-version` chained,
 * minus the diff output (the apply itself is the user-visible
 * outcome).
 */
export async function runUpdateToLatest(
  opts: StackUpdateOptions,
): Promise<void> {
  const fetchFn = opts.fetchFn ?? fetch;
  const latest = await fetchLatestVersion(
    fetchFn,
    "klio update --to-latest",
  );
  return runUpdateToVersion(opts, latest);
}


/**
 * `klio update --to-version <X>` — pin every klio image to tag <X>,
 * pull, and recreate engine/bridge/trust-app without touching
 * postgres/redis. Re-renders the compose template against the new
 * tag so subsequent `docker compose` commands the user runs by hand
 * also see the pin.
 *
 * Why we don't bounce postgres + redis: their images are pinned to
 * upstream tags (pgvector/pgvector:pg16, redis:7-alpine) that are
 * orthogonal to the @klio-tech/klio version. Recreating them would
 * cost a brief data-plane interruption for zero gain.
 *
 * Why semver validation matters: the version string is interpolated
 * into a YAML body that becomes a docker pull tag. We refuse anything
 * that isn't a clean MAJOR.MINOR.PATCH triple — both as a defence
 * against typos (`klio update --to-version 062`) and against shell
 * metacharacter injection in case a future caller forwards user
 * input here without sanitising.
 */
export async function runUpdateToVersion(
  opts: StackUpdateOptions,
  version: string,
): Promise<void> {
  if (!isCleanSemverTriple(version)) {
    process.stderr.write(
      `klio update --to-version: ${JSON.stringify(version)} is not a valid semver triple\n`,
    );
    process.exit(2);
  }

  const out = opts.stdout ?? process.stdout;
  out.write(`Re-rendering compose with image tag ${version}…\n`);

  // Recover the JWT signing key from the user's existing .env so the
  // re-rendered compose continues to interpolate it correctly. The
  // engine + trust-app verify session tokens with this key — losing
  // it (or rotating it inadvertently) would log every user out.
  const envPath = opts.envPath ?? join(runtimeDir(), ".env");
  const env = parseEnvFile(envPath);
  const jwtKey = env.KLIO_JWT_SIGNING_KEY;
  if (!jwtKey || jwtKey.length === 0) {
    process.stderr.write(
      "klio update --to-version: ~/.klio/.env is missing KLIO_JWT_SIGNING_KEY — re-run `klio init` first\n",
    );
    process.exit(1);
  }

  // The compose template's only per-call inputs are imageTag +
  // jwtSigningKey; embedding/extraction model defaults are encoded
  // in the template (provider config lives in .env, not in YAML).
  // Carrying any extra fields here would risk overriding the user's
  // provider picks — which is exactly the wrong thing for an upgrade
  // that should not touch their config.
  writeComposeFile({ imageTag: version, jwtSigningKey: jwtKey });

  out.write(`Pulling images for version ${version}…\n`);
  const apply = opts.composeApply ?? defaultComposeApply(opts);

  // `docker compose pull` resolves the (now-rewritten) `image:` tags
  // in the compose body and pulls them from ghcr.io. Pulling FIRST
  // means the recreate that follows finds the new layers locally and
  // doesn't have to reach the network mid-recreate (where a half-
  // applied state would leave services on inconsistent versions).
  await apply(["pull"]);

  out.write(
    `Recreating ${KLIO_SERVICES_FOR_APPLY.join(", ")} on ${version}…\n`,
  );
  // `--no-deps` is critical: without it, compose would also recreate
  // postgres + redis (engine declares depends_on against both), which
  // would force every connection through a reconnect storm for no
  // benefit. The new klio images can talk to the running data
  // services unchanged.
  await apply([
    "up",
    "-d",
    "--no-deps",
    ...KLIO_SERVICES_FOR_APPLY,
  ]);

  out.write(`✓ Updated to ${version}.\n`);
}


/**
 * Resolve the running klio version. Prefers ~/.klio/update-state.json
 * (the bridge ticker keeps it fresh) and falls back to this CLI's
 * package version when the state file is missing or corrupt.
 *
 * Corrupt JSON falls through to the package-version branch rather
 * than throwing: the caller is `--check`, the user just wants the
 * diff, and a corrupt state file is itself a sign that something is
 * off — surfacing it as "couldn't load state, falling back to CLI
 * version" is more useful than aborting.
 */
function readCurrentVersion(statePath: string): string {
  if (existsSync(statePath)) {
    try {
      const raw = readFileSync(statePath, "utf8");
      const parsed = JSON.parse(raw) as { current_version?: string };
      if (
        typeof parsed.current_version === "string" &&
        parsed.current_version.length > 0
      ) {
        return parsed.current_version;
      }
    } catch {
      // Fall through to packageVersion() — corrupt state file is
      // not worth crashing a read-only check over.
    }
  }
  return packageVersion();
}


/**
 * Hit the npm registry's `latest` endpoint and return the published
 * version string. Errors exit with a non-zero code and a stderr
 * message that names the calling subcommand so users can correlate
 * a failure log with the flag they typed.
 */
async function fetchLatestVersion(
  fetchFn: typeof fetch,
  label: string,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(NPM_LATEST_URL, { method: "GET" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `${label}: failed to reach ${NPM_LATEST_URL}: ${message}\n`,
    );
    process.exit(1);
  }
  if (!res.ok) {
    process.stderr.write(
      `${label}: HTTP ${res.status} from ${NPM_LATEST_URL}\n`,
    );
    process.exit(1);
  }
  let body: { version?: string };
  try {
    body = (await res.json()) as { version?: string };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${label}: parse error: ${message}\n`);
    process.exit(1);
  }
  if (typeof body.version !== "string" || body.version.length === 0) {
    process.stderr.write(
      `${label}: registry response missing version field\n`,
    );
    process.exit(1);
  }
  return body.version;
}


/**
 * Strict numeric-triple semver matcher. Rejects pre-release tags,
 * leading `v`, build metadata — anything other than `\d+.\d+.\d+`.
 * Pre-release suffixes are out of scope for v0.6.0 because npm's
 * `latest` channel only publishes stable triples.
 */
function isCleanSemverTriple(value: string): boolean {
  return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(value);
}


/**
 * Default `composeApply` — shells out to `docker compose -f <file>
 * <args...>` in the runtime dir. We resolve the compose binary
 * (plugin form vs v1 standalone) once per call rather than caching
 * because the v0.6.0 apply runs exactly two compose invocations
 * (`pull` then `up`) — the savings from caching wouldn't justify
 * the lifetime-management complexity.
 */
function defaultComposeApply(
  opts: StackUpdateOptions,
): (args: readonly string[]) => Promise<void> {
  return async (args) => {
    const composeFile =
      opts.composeFilePath ?? join(runtimeDir(), "docker-compose.yml");
    const cwd = composeFileDir(composeFile);
    const bin: ComposeBin = await resolveComposeBin();
    await runComposeArgs(bin, cwd, [...args]);
  };
}


/** Resolve the parent directory of a compose-file path. */
function composeFileDir(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? "." : filePath.slice(0, idx) || "/";
}


/**
 * Spawn `<bin.cmd> <bin.prefix...> <args...>` in `cwd` and resolve
 * when it exits 0. Output is piped through to the parent's stdio so
 * progress (image pulls, container creates) shows in real time —
 * distinct from the silent helpers in docker.ts which buffer stderr
 * and surface it on failure only. The stack-wide apply path is the
 * one place where a chatty docker UX is the right default; users
 * running `klio update --to-version` expect to see what's happening.
 */
async function runComposeArgs(
  bin: ComposeBin,
  cwd: string,
  args: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const argv = [...bin.prefix, ...args];
    const child = spawn(bin.cmd, argv, {
      cwd,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${bin.cmd} ${argv.join(" ")} exited ${code}`));
    });
  });
}
