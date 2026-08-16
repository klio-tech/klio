// Undo, on someone else's machine, a change we should not have made.
//
// 0.9.4 through 0.9.6 pointed Claude Code at the local proxy: `klio
// init` merged ANTHROPIC_BASE_URL and ENABLE_TOOL_SEARCH into
// ~/.claude/settings.json whenever Claude Code was installed. 0.9.7
// stops doing that (proxy/wiring.ts) because the trade was never worth
// taking:
//
//   * The benefit is zero. Klio's HOOKS already cover Claude Code end
//     to end — SessionStart injection, UserPromptSubmit / PostToolUse /
//     Stop capture — regardless of how it authenticates. Measured live:
//     64 memories in 15 minutes through hooks alone.
//   * On a Claude SUBSCRIPTION the proxy is not merely redundant, it is
//     never contacted: Claude Code on OAuth does not route to a custom
//     base URL at all. Zero connections ever reached a healthy proxy.
//   * The cost is real and permanent while it is in place: Remote
//     Control (Claude Code v2.1.196+) does not work with a custom base
//     URL, and no flag brings it back.
//
// Shipping the fix only for NEW installs would leave every 0.9.4–0.9.6
// user paying that cost forever, with no signal telling them why their
// phone stopped controlling their session. So `klio init` and `klio
// doctor` undo it.
//
// THE RULE, and the reason this is a separate function rather than a
// call to `removeProxyEnv`: this runs UNPROMPTED. It may only restore
// what Klio's own record (~/.klio/proxy-wiring.json) says Klio set, and
// only where the value on disk is still exactly what Klio wrote. Every
// other case — no record, a record for a different settings file, a key
// the record does not mention, a value someone has since changed — is
// left alone AND REPORTED, because an unprompted write over a value we
// cannot prove we authored is precisely the class of damage this module
// exists to repair. `removeProxyEnv` (the `klio uninit` path) is
// deliberately less conservative: there the user asked, in so many
// words, for our wiring to go away.

import { existsSync } from "node:fs";

import { readJson, writeJson } from "../adapters/fileutil.js";
import { claudeSettingsPath, type EnvKeyChange, type ProxyWiringPaths } from "./claudeCodeProxy.js";
import { CLAUDE_ENV_KEYS, claudeProxyEnv } from "./constants.js";
import { clearWiringTarget, readWiringState, wiringStatePath } from "./state.js";

/**
 * What happened, in one word, so callers can decide whether to print
 * anything at all. `left-alone` is not a failure — it is the safe
 * outcome, and the one that has to be SAID rather than swallowed.
 */
export type MigrationOutcome =
  | "not-installed"
  | "nothing-to-undo"
  | "restored"
  | "left-alone"
  | "unreadable";

/** Why one key was not touched. */
export type MigrationSkipReason =
  | "changed-elsewhere"
  | "no-record"
  | "record-is-for-another-file";

export type MigrationSkip = { key: string; value: string; reason: MigrationSkipReason };

export type ClaudeCodeMigration = {
  settingsPath: string;
  outcome: MigrationOutcome;
  /** Keys actually restored (or deleted, when they were absent before). */
  changes: EnvKeyChange[];
  /** Keys that carry Klio's value but were not restored, and why. */
  skipped: MigrationSkip[];
  /** One line fit to print. Always populated. */
  detail: string;
};

/**
 * Restore Claude Code's settings to what they were before Klio pointed
 * them at the proxy.
 *
 * NEVER throws. `klio init` must not fail because a settings file does
 * not parse, and neither must `klio doctor` — both report and move on.
 */
export function migrateClaudeCodeProxyEnv(paths: ProxyWiringPaths = {}): ClaudeCodeMigration {
  const path = paths.settingsPath ?? claudeSettingsPath();
  const statePath = paths.statePath ?? wiringStatePath();

  if (!existsSync(path)) {
    return done(path, "not-installed", [], [], "Claude Code settings not found — nothing to undo");
  }

  let settings: Record<string, unknown>;
  try {
    settings = readJson(path);
  } catch (err) {
    return done(
      path,
      "unreadable",
      [],
      [],
      `${path} could not be parsed as JSON — left it alone ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const env = isPlainObject(settings["env"])
    ? { ...(settings["env"] as Record<string, unknown>) }
    : null;
  if (env === null) {
    return done(path, "nothing-to-undo", [], [], "Claude Code was not wired to the proxy");
  }

  const ours = claudeProxyEnv();
  // Only keys that still hold EXACTLY what Klio writes are candidates.
  // Anything else is someone else's value by definition.
  const present = CLAUDE_ENV_KEYS.filter((key) => typeof env[key] === "string");
  if (present.length === 0) {
    return done(path, "nothing-to-undo", [], [], "Claude Code was not wired to the proxy");
  }

  const record = readWiringState(statePath).claudeCode;
  const recordCoversThisFile = record !== undefined && record.settingsPath === path;

  const changes: EnvKeyChange[] = [];
  const skipped: MigrationSkip[] = [];

  for (const key of present) {
    const current = env[key] as string;

    if (current !== ours[key]) {
      skipped.push({ key, value: current, reason: "changed-elsewhere" });
      continue;
    }
    if (record === undefined) {
      skipped.push({ key, value: current, reason: "no-record" });
      continue;
    }
    if (!recordCoversThisFile) {
      skipped.push({ key, value: current, reason: "record-is-for-another-file" });
      continue;
    }
    if (!(key in record.previous)) {
      // Klio's record does not claim this key, so Klio cannot claim to
      // know what it held before.
      skipped.push({ key, value: current, reason: "no-record" });
      continue;
    }

    const restore = record.previous[key] ?? null;
    if (restore === null) delete env[key];
    else env[key] = restore;
    changes.push({ key, from: current, to: restore });
  }

  if (changes.length === 0) {
    const outcome: MigrationOutcome = skipped.length === 0 ? "nothing-to-undo" : "left-alone";
    return done(path, outcome, [], skipped, describeSkips(skipped, path));
  }

  // Same read-merge-write discipline as every other writer of this
  // file: touch the two keys, rebuild nothing, and drop an `env` object
  // only once it is genuinely empty.
  if (Object.keys(env).length === 0) delete settings["env"];
  else settings["env"] = env;

  try {
    writeJson(path, settings);
  } catch (err) {
    return done(
      path,
      "unreadable",
      [],
      skipped,
      `could not write ${path} — left it alone ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // The record has served its purpose for every key it covered. Keep it
  // when something was left alone, so a later run (or `klio uninit`)
  // still has the undo information for the key we did not touch.
  if (skipped.length === 0) {
    try {
      clearWiringTarget("claudeCode", statePath);
    } catch {
      // A state file we cannot rewrite is not a reason to fail a repair
      // that already landed on disk.
    }
  }

  const restored = changes
    .map((c) => (c.to === null ? `removed ${c.key}` : `restored ${c.key}=${c.to}`))
    .join(", ");
  return done(
    path,
    "restored",
    changes,
    skipped,
    `undid Klio's proxy wiring in ${path} — ${restored}` +
      (skipped.length > 0 ? `; ${describeSkips(skipped, path)}` : ""),
  );
}

function describeSkips(skipped: MigrationSkip[], path: string): string {
  if (skipped.length === 0) return "Claude Code was not wired to the proxy";
  return skipped
    .map((s) => {
      const why =
        s.reason === "changed-elsewhere"
          ? "it is not the value Klio writes, so something else set it"
          : s.reason === "record-is-for-another-file"
            ? "Klio's record is for a different settings file"
            : "Klio has no record of setting it";
      return `left ${s.key} in ${path} alone — ${why}`;
    })
    .join("; ");
}

function done(
  settingsPath: string,
  outcome: MigrationOutcome,
  changes: EnvKeyChange[],
  skipped: MigrationSkip[],
  detail: string,
): ClaudeCodeMigration {
  return { settingsPath, outcome, changes, skipped, detail };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
