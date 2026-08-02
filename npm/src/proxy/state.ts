// What the proxy wiring changed, so it can be changed back exactly.
//
// `klio uninit` has to "remove exactly what init added, leaving
// everything else intact". That is impossible from the config file
// alone. Consider a user who already had ANTHROPIC_BASE_URL pointing at
// their company's LLM gateway before they ever ran `klio init`:
//
//   - init overwrites it with http://localhost:8787
//   - uninit deletes the key
//   - the user's gateway config is gone, and nothing in either file
//     ever recorded that it existed
//
// Deleting is not undoing. So init records the prior value here first —
// including the distinction between "was set to X" and "was absent",
// which JSON can express as a value vs `null` but a config file cannot.
//
// The file lives in ~/.klio alongside the compose file and .env, is
// mode 0600 like its neighbours, and is disposable: if it is missing,
// uninit falls back to removing only values that still match what init
// wrote, which is the conservative choice.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runtimeDir } from "../compose.js";

/** Current on-disk schema version. Bumped if the shape ever changes. */
export const WIRING_STATE_VERSION = 1;

/**
 * A value a config key held before Klio touched it. `null` means the
 * key was ABSENT, which is different from being present and empty —
 * conflating the two is how uninit leaves an `"ANTHROPIC_BASE_URL": ""`
 * behind that breaks the agent more subtly than any missing key.
 */
export type PriorValue = string | null;

export type ClaudeCodeWiringState = {
  settingsPath: string;
  /** Prior values, keyed by env-var name. */
  previous: Record<string, PriorValue>;
  appliedAt: string;
};

export type CodexWiringState = {
  configPath: string;
  /** Prior `model_provider` selection, or null when unset. */
  previousModelProvider: PriorValue;
  /** True when init created the provider block (so uninit may remove it). */
  createdProviderBlock: boolean;
  appliedAt: string;
};

export type ProxyWiringState = {
  version: number;
  claudeCode?: ClaudeCodeWiringState;
  codex?: CodexWiringState;
};

export function wiringStatePath(): string {
  return join(runtimeDir(), "proxy-wiring.json");
}

/**
 * Read the recorded wiring state.
 *
 * Returns an empty state for a missing OR unreadable file rather than
 * throwing. A corrupt state file must not be able to block `klio
 * uninit` — the user reaching for uninit is already having a bad time,
 * and the fallback path (remove only what still matches) is safe.
 */
export function readWiringState(path = wiringStatePath()): ProxyWiringState {
  if (!existsSync(path)) return { version: WIRING_STATE_VERSION };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { version: WIRING_STATE_VERSION };
    }
    return parsed as ProxyWiringState;
  } catch {
    return { version: WIRING_STATE_VERSION };
  }
}

/**
 * Merge `patch` into the recorded state and persist it.
 *
 * Merge rather than replace because Claude Code and Codex are wired by
 * independent code paths, and a user may wire one, then the other. A
 * wholesale write from the second would erase the first's undo record.
 */
export function updateWiringState(
  patch: Partial<Omit<ProxyWiringState, "version">>,
  path = wiringStatePath(),
): ProxyWiringState {
  const current = readWiringState(path);
  const next: ProxyWiringState = {
    ...current,
    ...patch,
    version: WIRING_STATE_VERSION,
  };
  mkdirSync(runtimeDirOf(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

/**
 * Drop one target's record after a successful uninit, so a second
 * uninit is a clean no-op rather than trying to restore twice.
 */
export function clearWiringTarget(
  target: "claudeCode" | "codex",
  path = wiringStatePath(),
): void {
  const current = readWiringState(path);
  if (!(target in current)) return;
  const next: ProxyWiringState = { ...current, version: WIRING_STATE_VERSION };
  delete next[target];
  mkdirSync(runtimeDirOf(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Parent directory of `path`. Local rather than importing `dirname` so
 * the injected-path form used by tests behaves identically to the
 * production default.
 */
function runtimeDirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}
