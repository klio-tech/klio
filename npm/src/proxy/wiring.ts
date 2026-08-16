// Orchestrates proxy wiring across every agent, and says what it cost.
//
// WHO GETS WIRED, and why it is not everyone.
//
// Through 0.9.6 this wired Claude Code whenever it was installed:
// ANTHROPIC_BASE_URL and ENABLE_TOOL_SEARCH merged into
// ~/.claude/settings.json. It should never have. The benefit is zero —
// Klio's HOOKS already cover Claude Code end to end (SessionStart
// injection; UserPromptSubmit / PostToolUse / Stop capture) regardless
// of how it authenticates, measured at 64 memories in 15 minutes — and
// on a Claude SUBSCRIPTION the proxy is not even contacted: Claude Code
// on OAuth does not route to a custom base URL at all, measured at zero
// connections against a healthy proxy. Meanwhile the cost is real:
// Remote Control (Claude Code v2.1.196+) does not work with a custom
// base URL and no flag brings it back.
//
// So 0.9.7 wires the agents that have NO hooks — Codex above all, and
// anything self-built that can point at a base URL — and undoes, on
// every `klio init` and `klio doctor`, what the older versions did to
// Claude Code (proxy/claudeCodeMigration.ts).
//
// "Print what changed and what it costs" remains a requirement rather
// than polish: everything the proxy does to a request is invisible
// otherwise.

import {
  claudeSettingsPath,
  removeProxyEnv,
  type ClaudeProxyResult,
} from "./claudeCodeProxy.js";
import {
  migrateClaudeCodeProxyEnv,
  type ClaudeCodeMigration,
} from "./claudeCodeMigration.js";
import {
  applyCodexProxy,
  codexInstalled,
  removeCodexProxy,
  type CodexProxyResult,
} from "./codexProxy.js";
import { PROXY_BASE_URL } from "./constants.js";

export type WireProxyResult = {
  /** Only ever set by `unwireProxy` — nothing wires Claude Code any more. */
  claudeCode?: ClaudeProxyResult;
  /** What `wireProxy` undid (or declined to undo) of an older Klio's doing. */
  claudeCodeMigration?: ClaudeCodeMigration;
  codex?: CodexProxyResult;
  /** Agents that were not found on this machine, so were skipped. */
  skipped: string[];
  /** Non-fatal failures, per agent. */
  errors: { agent: string; message: string }[];
};

export type WireProxyOptions = {
  log: (line: string) => void;
  /** Overridden by tests; production uses the real home directory. */
  claudeSettings?: string;
  codexConfig?: string;
  statePath?: string;
};

/**
 * Wire every installed HOOKLESS agent to the proxy, and undo any
 * Claude Code wiring an older Klio left behind.
 *
 * Per-agent failures are collected rather than thrown: one agent's
 * broken config file must not stop the other from being wired, and
 * neither should abort `klio init` when the stack itself came up fine.
 */
export function wireProxy(opts: WireProxyOptions): WireProxyResult {
  const result: WireProxyResult = { skipped: [], errors: [] };
  const settingsPath = opts.claudeSettings ?? claudeSettingsPath();

  // Claude Code is deliberately NOT wired (see the module docblock).
  // The only thing done to its settings is taking BACK what 0.9.4–0.9.6
  // put there. `migrateClaudeCodeProxyEnv` never throws; the guard is
  // belt-and-braces, because nothing here may fail `klio init`.
  try {
    result.claudeCodeMigration = migrateClaudeCodeProxyEnv({
      settingsPath,
      statePath: opts.statePath,
    });
  } catch (err) {
    result.errors.push({ agent: "claude-code", message: messageOf(err) });
  }

  if (opts.codexConfig !== undefined || codexInstalled()) {
    try {
      result.codex = applyCodexProxy({
        configPath: opts.codexConfig,
        statePath: opts.statePath,
      });
    } catch (err) {
      result.errors.push({ agent: "codex", message: messageOf(err) });
    }
  } else {
    result.skipped.push("codex");
  }

  return result;
}

/**
 * Undo `wireProxy` for every agent. Same per-agent isolation.
 *
 * Claude Code is still cleaned here even though nothing wires it any
 * more: `klio uninit` is the escape hatch, and it has to remove an
 * older Klio's entries from a machine where — for any reason at all —
 * the init-time migration did not run or could not finish. Unlike the
 * migration, `removeProxyEnv` may act without a state record: the user
 * asked for our wiring to go away, in so many words.
 */
export function unwireProxy(opts: WireProxyOptions): WireProxyResult {
  const result: WireProxyResult = { skipped: [], errors: [] };
  const settingsPath = opts.claudeSettings ?? claudeSettingsPath();

  try {
    result.claudeCode = removeProxyEnv({ settingsPath, statePath: opts.statePath });
  } catch (err) {
    result.errors.push({ agent: "claude-code", message: messageOf(err) });
  }

  try {
    result.codex = removeCodexProxy({
      configPath: opts.codexConfig,
      statePath: opts.statePath,
    });
  } catch (err) {
    result.errors.push({ agent: "codex", message: messageOf(err) });
  }

  return result;
}

/**
 * Report what wiring changed and what it costs, in that order.
 *
 * The trade-offs are printed even when nothing changed (a re-run), so a
 * user who forgot what the proxy does to their traffic can re-run init
 * and be told.
 */
export function describeWiring(result: WireProxyResult, log: (line: string) => void): void {
  describeClaudeCodeMigration(result.claudeCodeMigration, log);

  const cc = result.claudeCode;
  if (cc) {
    if (cc.changes.length === 0) {
      log(`    · Claude Code already pointed at ${PROXY_BASE_URL}`);
    } else {
      log(`    · ${cc.settingsPath}`);
      for (const change of cc.changes) {
        const from = change.from === null ? "(unset)" : change.from;
        log(`        ${change.key}: ${from} → ${change.to}`);
      }
    }
    for (const conflict of cc.conflicts) {
      log(`    ! ${conflict.key} was changed by something else — left it alone`);
    }
  }

  if (result.codex) {
    log(`    · ${result.codex.configPath}`);
    log(`        ${result.codex.summary}`);
    if (result.codex.replacedProvider) {
      log(
        `    ! Codex was using model_provider = "${result.codex.replacedProvider}". ` +
          `\`klio uninit\` puts it back.`,
      );
    }
  }

  for (const skipped of result.skipped) {
    log(`    — ${skipped} not found on this machine, skipped`);
  }
  log("    — Claude Code is covered by Klio's hooks, so it is NOT wired to");
  log("      the proxy and its settings.json is left as it is.");
  for (const error of result.errors) {
    log(`    ✗ ${error.agent}: ${error.message}`);
  }
}

/**
 * Say what the Claude Code migration did — and, just as importantly,
 * what it declined to do.
 *
 * Silence is not an option in either direction. A user whose Remote
 * Control has been broken since 0.9.4 needs to see it come back, or
 * they will not know to try it again; and a user whose ANTHROPIC_BASE_URL
 * we left alone needs to know it is still there, since we are the
 * likeliest reason it is.
 */
export function describeClaudeCodeMigration(
  migration: ClaudeCodeMigration | undefined,
  log: (line: string) => void,
): void {
  if (migration === undefined) return;
  if (migration.outcome === "restored") {
    log(`    ✓ Undid an earlier Klio's proxy wiring in ${migration.settingsPath}`);
    for (const change of migration.changes) {
      log(
        change.to === null
          ? `        removed ${change.key}`
          : `        restored ${change.key} = ${change.to}`,
      );
    }
    log("      Claude Code's Remote Control works again. Klio's hooks were");
    log("      always doing the real work there.");
  }
  for (const skip of migration.skipped) {
    log(`    ! Left ${skip.key} = ${skip.value} alone in ${migration.settingsPath}`);
  }
  if (migration.outcome === "left-alone" || migration.outcome === "unreadable") {
    log(`      ${migration.detail}`);
  }
}

/**
 * The costs of routing through a non-Anthropic base URL. Printed at
 * init time because all of them are silent otherwise.
 *
 * This block is the informed-consent surface — the last thing a user
 * reads before agreeing to route every model call through a process we
 * installed — so its accuracy is functional, not cosmetic. Two
 * corrections are baked in, and neither may be undone:
 *
 *   1. It once said "This release is PASS-THROUGH ONLY — it forwards
 *      traffic unchanged", which was true of the PYTHON proxy (proxy/,
 *      still the local stack's) and false of this one.
 *   2. It then presented the proxy as how CLAUDE CODE receives team
 *      context. Measured on a real machine on 2026-08-15:
 *      ANTHROPIC_BASE_URL pointed at a healthy inject+capture proxy,
 *      Claude Code restarted and used — and ZERO connections ever
 *      reached the proxy, because Claude Code authenticates by
 *      subscription OAuth and does not route to a custom base URL under
 *      it. Over the same fifteen minutes the HOOK path wrote 64
 *      memories and injected on SessionStart. So for Claude Code the
 *      proxy is, at best, redundant with hooks and, on a subscription,
 *      a complete no-op. Selling it as the Claude Code integration was
 *      selling nothing.
 *
 * What the proxy is genuinely for is agents that CANNOT do hooks —
 * Codex above all, and any self-built agent with a base-URL override.
 * That is what this block now says.
 *
 * It also has to describe controls that WORK. "Turn either half off at
 * any time" pointed only at `KLIO_PROXY_CAPTURE=off`, which the
 * supervised deployment — the only one `klio init` produces — silently
 * reverted on every restart, because the proxy is launchd's or
 * systemd's grandchild and never sees the user's shell. The durable
 * switch is `klio proxy capture off` (proxy/toggles.ts); the env var is
 * named here only as the per-process override it actually is.
 */
export function describeTradeoffs(log: (line: string) => void): void {
  log("");
  log("    What this changes, and what it costs:");
  log("");
  log("      • Claude Code is NOT wired to the proxy. Saying yes never");
  log("        touches its settings.json. Klio's hooks already cover it");
  log("        end to end — team context is injected at SessionStart, and");
  log("        your sessions are captured from PostToolUse and");
  log("        UserPromptSubmit — and hooks work no matter how Claude Code");
  log("        authenticates. The proxy adds nothing for it.");
  log("        In fact, if you are on a Claude subscription (rather than an");
  log("        ANTHROPIC_API_KEY), Claude Code will not send traffic to a");
  log("        custom base URL at all, so it would change nothing whatsoever");
  log("        for it. Measured, not theorised.");
  log("");
  log("      • The proxy exists for agents WITHOUT hook support: Codex,");
  log("        and anything you build yourself that can point at a base");
  log("        URL. Those agents have no other way to receive your team's");
  log("        memories or to send sessions back as grading evidence.");
  log("        That is the whole reason to say yes.");
  log("");
  log("      • What it does to a request. On Anthropic's /v1/messages it");
  log("        APPENDS your Klio memories to the request's `system` field;");
  log("        on OpenAI's /v1/responses — the API Codex speaks — it");
  log("        appends them to `instructions`. Either way it then sends");
  log("        the conversation to Klio as grading evidence.");
  log("        Exactly ONE field is touched, and only ever appended to.");
  log("        Nothing else: `messages`, `input`, `tools`, `tool_choice`,");
  log("        `tool_reference` blocks and every tool-call id are");
  log("        forwarded byte for byte, and any doubt forwards your");
  log("        original bytes unmodified.");
  log("        Turn either half off at any time, without uninstalling:");
  log("        `klio proxy capture off` and `klio proxy inject off`.");
  log("        The choice is saved in ~/.klio/config.json and survives");
  log("        restarts, reboots and re-running `klio init`. (The env vars");
  log("        KLIO_PROXY_CAPTURE / KLIO_PROXY_INJECT still override it for");
  log("        one process — but only a process YOUR shell starts, which is");
  log("        why they are not the durable switch.)");
  log("        There is no compression yet, so no token savings yet.");
  log("");
  log("      • Klio 0.9.4–0.9.6 DID point Claude Code at the proxy, which");
  log("        disabled Remote Control — v2.1.196+ is incompatible with a");
  log("        custom base URL and no flag re-enables it. 0.9.7 takes that");
  log("        back: `klio init` and `klio doctor` restore whatever those");
  log("        versions recorded, so Remote Control works again.");
  log("        Only values Klio's own record says Klio set are touched —");
  log("        anything you set yourself is left exactly where it is.");
  log("");
  log("      • A dead proxy means any agent that DOES route through it");
  log("        cannot reach a model at all — Codex, and anything else you");
  log("        pointed at it. A supervisor keeps it alive; `klio doctor`");
  log("        checks and heals it.");
  log("");
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
