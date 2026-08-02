// Point Claude Code at the local proxy, by merging into (never
// replacing) ~/.claude/settings.json.
//
//   { "env": { "ANTHROPIC_BASE_URL": "http://localhost:8787",
//              "ENABLE_TOOL_SEARCH": "true" } }
//
// That file has more than one writer. Claude Code itself writes theme,
// effortLevel and permissions. Klio already writes six lifecycle hooks
// and a permissions.allow list. A wholesale write by any party silently
// destroys the others' entries — and settings.json is not a file users
// keep in version control, so the loss is discovered days later as
// "Klio stopped working" or "my permissions reset".
//
// So every write here is read → merge → write, touching exactly the two
// keys under `env` and nothing else. Not even the surrounding `env`
// object is rebuilt: other tools put their variables there too.
//
// Why `env` at all rather than asking users to export a shell variable:
// the `env` block is documented and supported, and is honoured
// identically to the real process environment. It survives Claude Code
// upgrades — Klio's hooks have been in this file across several already
// — and it means the wiring happens once instead of every terminal.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readJson, writeJson } from "../adapters/fileutil.js";
import { CLAUDE_ENV_KEYS, claudeProxyEnv } from "./constants.js";
import {
  clearWiringTarget,
  readWiringState,
  updateWiringState,
  wiringStatePath,
  type PriorValue,
} from "./state.js";

export function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

export type EnvKeyChange = {
  key: string;
  /** What the key held before, or null when it was absent. */
  from: PriorValue;
  /** What it holds now, or null when removed. */
  to: PriorValue;
};

/**
 * Paths the wiring touches. Both are injectable so tests exercise the
 * real read-merge-write code against a temp directory instead of the
 * developer's own ~/.claude — a test suite that can corrupt the machine
 * it runs on is a test suite people stop running.
 */
export type ProxyWiringPaths = {
  /** Defaults to ~/.claude/settings.json. */
  settingsPath?: string;
  /** Defaults to ~/.klio/proxy-wiring.json. */
  statePath?: string;
};

export type ClaudeProxyResult = {
  settingsPath: string;
  /** Only keys whose value actually changed. Empty on a no-op re-run. */
  changes: EnvKeyChange[];
  /**
   * Keys left alone because another writer had set them to something
   * that was neither absent nor ours. Surfaced rather than silently
   * overwritten (on apply) or deleted (on remove).
   */
  conflicts: EnvKeyChange[];
};

/**
 * Merge the proxy env block into ~/.claude/settings.json.
 *
 * Idempotent: a second run with the same proxy URL reports no changes
 * and rewrites the file identically.
 *
 * Records prior values so `removeProxyEnv` can restore rather than
 * merely delete. A user who already pointed ANTHROPIC_BASE_URL at a
 * corporate gateway gets that value back on uninit; deleting the key
 * would leave them silently talking to Anthropic directly.
 */
export function applyProxyEnv(paths: ProxyWiringPaths = {}): ClaudeProxyResult {
  const path = paths.settingsPath ?? claudeSettingsPath();
  const statePath = paths.statePath ?? wiringStatePath();
  const settings = readJson(path);
  const desired = claudeProxyEnv();

  const env = isPlainObject(settings["env"])
    ? { ...(settings["env"] as Record<string, unknown>) }
    : {};

  const changes: EnvKeyChange[] = [];
  const previous: Record<string, PriorValue> = {};

  for (const key of CLAUDE_ENV_KEYS) {
    const before = typeof env[key] === "string" ? (env[key] as string) : null;
    previous[key] = before;
    if (before === desired[key]) continue; // already correct — leave the file alone
    env[key] = desired[key];
    changes.push({ key, from: before, to: desired[key] });
  }

  // Only touch disk when something actually changed. A no-op re-run
  // that still rewrites the file would churn its mtime and, more to the
  // point, widen the window in which a concurrent Claude Code write can
  // be lost.
  if (changes.length > 0) {
    settings["env"] = env;
    writeJson(path, settings);

    // Record prior values only on a real change. Re-running init must
    // not overwrite the ORIGINAL prior value with our own — that would
    // make uninit restore http://localhost:8787, which is the thing it
    // exists to undo.
    const existing = readWiringState(statePath).claudeCode;
    updateWiringState(
      {
        claudeCode: {
          settingsPath: path,
          previous: existing?.previous ?? previous,
          appliedAt: new Date().toISOString(),
        },
      },
      statePath,
    );
  }

  return { settingsPath: path, changes, conflicts: [] };
}

/**
 * Undo `applyProxyEnv`: restore each key's recorded prior value, or
 * delete it when there was none.
 *
 * A key whose current value is neither what we wrote nor absent is
 * reported as a conflict and left untouched. Someone — the user, or
 * another tool — set it deliberately after we did, and clobbering that
 * would repeat the exact mistake this module exists to avoid.
 */
export function removeProxyEnv(paths: ProxyWiringPaths = {}): ClaudeProxyResult {
  const path = paths.settingsPath ?? claudeSettingsPath();
  const statePath = paths.statePath ?? wiringStatePath();
  if (!existsSync(path)) {
    return { settingsPath: path, changes: [], conflicts: [] };
  }

  const settings = readJson(path);
  if (!isPlainObject(settings["env"])) {
    clearWiringTarget("claudeCode", statePath);
    return { settingsPath: path, changes: [], conflicts: [] };
  }

  const env = { ...(settings["env"] as Record<string, unknown>) };
  const ours = claudeProxyEnv();
  const recorded = readWiringState(statePath).claudeCode?.previous ?? {};

  const changes: EnvKeyChange[] = [];
  const conflicts: EnvKeyChange[] = [];

  for (const key of CLAUDE_ENV_KEYS) {
    const current = typeof env[key] === "string" ? (env[key] as string) : null;
    if (current === null) continue; // nothing of ours to remove

    if (current !== ours[key]) {
      // Changed by someone else since we wrote it. Leave it.
      conflicts.push({ key, from: current, to: current });
      continue;
    }

    const restore = recorded[key] ?? null;
    if (restore === null) {
      delete env[key];
    } else {
      env[key] = restore;
    }
    changes.push({ key, from: current, to: restore });
  }

  if (changes.length > 0) {
    // Drop an `env` object we have emptied, so uninit does not leave a
    // vestigial `"env": {}` behind. Any other key means someone else is
    // using it and it stays.
    if (Object.keys(env).length === 0) {
      delete settings["env"];
    } else {
      settings["env"] = env;
    }
    writeJson(path, settings);
  }

  if (conflicts.length === 0) clearWiringTarget("claudeCode", statePath);

  return { settingsPath: path, changes, conflicts };
}

/**
 * Read the currently-wired values without modifying anything. Used by
 * `klio doctor` to decide whether the entry needs re-applying.
 */
export function readProxyEnv(path = claudeSettingsPath()): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  let env: Record<string, unknown> = {};
  try {
    const settings = readJson(path);
    if (isPlainObject(settings["env"])) env = settings["env"] as Record<string, unknown>;
  } catch {
    // A settings.json that does not parse is a real problem, but it is
    // doctor's job to report it as one rather than crash while
    // gathering facts. Every key reads as absent.
  }
  for (const key of CLAUDE_ENV_KEYS) {
    out[key] = typeof env[key] === "string" ? (env[key] as string) : null;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
