/**
 * `klio configure` — top-level subcommand for adjusting persistent
 * settings without re-running `klio init`.
 *
 * Two targets in v0.6.0:
 *   `klio configure auto-update {apply, notify, off}`
 *     - Writes KLIO_AUTO_UPDATE=<mode> into ~/.klio/.env via
 *       mergeEnvFile. The bridge's updater ticker reads this on
 *       its next iteration; no restart required.
 *
 *   `klio configure email <addr>`
 *     - Posts the email to POST /v1/auth/login-link on the local
 *       engine. The engine's existing magic-link flow takes over —
 *       sends a link that, when clicked, sets users.claimed_at =
 *       now() for the bearer-authenticated user.
 *     - Validates the email's basic shape before posting.
 *
 * Usage shape mirrors `klio update <target>` from v0.5.0.
 */

import { join } from "node:path";

import { runtimeDir } from "../compose.js";
import { mergeEnvFile } from "../envFile.js";


const VALID_AUTO_UPDATE_MODES = ["apply", "notify", "off"] as const;
type AutoUpdateMode = (typeof VALID_AUTO_UPDATE_MODES)[number];

const DEFAULT_ENGINE_URL = "http://127.0.0.1:8000";


/**
 * Hook seam used by tests. Production callers leave the override
 * fields undefined and fall back to real I/O + the real `fetch`.
 *
 * Why a struct rather than module-level mocking: the npm package
 * publishes plain ESM and avoids any runtime dependency, so the test
 * suite can't reach for jest-style auto-mocks. Threading the
 * collaborators through the call signature keeps the production code
 * clean and the test path explicit. Same shape as `UpdateOptions`
 * in `./update.ts`.
 */
export type ConfigureOptions = {
  /** Residual argv after `klio configure` (e.g. ["auto-update", "apply"]). */
  args: readonly string[];
  /** Override for tests; production defaults to ~/.klio/.env. */
  envPath?: string;
  /** Override for tests; production defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Override the engine URL (default http://127.0.0.1:8000). */
  engineURL?: string;
};


export type ConfigureTarget = "auto-update" | "email" | "menu" | "unknown";


/** Parse the residual argv after `klio configure`. */
export function parseConfigureTarget(
  args: readonly string[],
): ConfigureTarget {
  if (args.length === 0) return "menu";
  const first = args[0];
  if (first === "auto-update" || first === "email") {
    return first;
  }
  return "unknown";
}


export async function runConfigure(opts: ConfigureOptions): Promise<void> {
  const target = parseConfigureTarget(opts.args);
  switch (target) {
    case "menu":
      printUsage();
      process.exit(2);
      return;
    case "unknown":
      process.stderr.write(
        `klio configure: unknown target ${JSON.stringify(opts.args[0])}\n`,
      );
      printUsage();
      process.exit(2);
      return;
    case "auto-update":
      await runConfigureAutoUpdate(opts);
      return;
    case "email":
      await runConfigureEmail(opts);
      return;
  }
}


function printUsage(): void {
  process.stdout.write(
    "usage:\n" +
      "  klio configure auto-update {apply, notify, off}\n" +
      "  klio configure email <addr>\n",
  );
}


/**
 * `klio configure auto-update <mode>` — persist the auto-update
 * preference. The bridge's updater ticker reads ~/.klio/.env on its
 * 6h tick (and on engine restart), so the change takes effect without
 * a stack bounce — at most one tick later.
 *
 * Modes:
 *   apply   — bridge fetches and applies updates automatically.
 *   notify  — bridge writes update-state.json so the dashboard can
 *             surface a banner; user applies manually.
 *   off     — bridge skips the update check entirely.
 */
async function runConfigureAutoUpdate(opts: ConfigureOptions): Promise<void> {
  const mode = opts.args[1];
  if (!isValidMode(mode)) {
    process.stderr.write(
      `klio configure auto-update: invalid mode ${JSON.stringify(mode)} ` +
        `— must be one of: ${VALID_AUTO_UPDATE_MODES.join(", ")}\n`,
    );
    process.exit(2);
    return;
  }
  const envPath = opts.envPath ?? join(runtimeDir(), ".env");
  // Targeted-merge: every other key in .env (JWT signing key,
  // provider creds, curator block, user/agent UUIDs) is preserved.
  mergeEnvFile(envPath, { KLIO_AUTO_UPDATE: mode });
  process.stdout.write(`✓ Saved. KLIO_AUTO_UPDATE=${mode}\n`);
  process.stdout.write(
    "The bridge ticker picks up the new mode on its next 6h tick (or on engine restart).\n",
  );
}


function isValidMode(s: unknown): s is AutoUpdateMode {
  return (
    typeof s === "string" &&
    (VALID_AUTO_UPDATE_MODES as readonly string[]).includes(s)
  );
}


/**
 * `klio configure email <addr>` — POST the email to the engine's
 * `/v1/auth/login-link` endpoint. The engine handles magic-link
 * generation + delivery; once the user clicks the link, the engine
 * sets `users.claimed_at = now()` for the bearer-authenticated user.
 *
 * We do a permissive client-side shape check here so an obvious typo
 * (`abhishek@`, `foo`) gets a fast local error rather than a 422
 * round-trip. The engine's pydantic[email] validator is the source
 * of truth — anything that passes our regex still gets re-validated
 * server-side.
 */
async function runConfigureEmail(opts: ConfigureOptions): Promise<void> {
  const email = opts.args[1];
  if (!email || !looksLikeEmail(email)) {
    process.stderr.write(
      `klio configure email: bad email ${JSON.stringify(email)}\n`,
    );
    process.exit(2);
    return;
  }
  const engineURL = opts.engineURL ?? DEFAULT_ENGINE_URL;
  const fetchImpl = opts.fetchFn ?? fetch;
  const url = engineURL.replace(/\/+$/, "") + "/v1/auth/login-link";
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    process.stderr.write(
      `klio configure email: HTTP ${res.status} from engine\n${text.trim()}\n`,
    );
    process.exit(1);
    return;
  }
  process.stdout.write(
    `✓ Magic link sent to ${email}. Click it to claim your account.\n`,
  );
}


/**
 * Permissive email shape check — catches obvious typos so the user
 * gets a fast local error rather than a 422 round-trip. The engine's
 * pydantic[email] validator runs server-side and is the source of
 * truth for what's actually accepted.
 */
function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
