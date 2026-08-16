// Orchestrates proxy wiring across every agent, and says what it cost.
//
// "Print what changed and what it costs" is a requirement, not polish.
// Pointing ANTHROPIC_BASE_URL at a non-Anthropic host has two
// consequences the user will otherwise discover the hard way:
//
//   1. MCP Tool Search is disabled by default. We re-enable it with
//      ENABLE_TOOL_SEARCH=true — without which routing through the
//      proxy is a NET TOKEN LOSS (~85% on tool schemas, against ~20%
//      saved on prose), invisible to the user.
//   2. Remote Control (Claude Code v2.1.196+) is disabled, and there is
//      no flag that brings it back.
//
// The second one has no mitigation, so the only honest thing to do is
// say it at init time rather than let someone spend an evening working
// out why their phone stopped controlling their session.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  applyProxyEnv,
  claudeSettingsPath,
  removeProxyEnv,
  type ClaudeProxyResult,
} from "./claudeCodeProxy.js";
import {
  applyCodexProxy,
  codexInstalled,
  removeCodexProxy,
  type CodexProxyResult,
} from "./codexProxy.js";
import { PROXY_BASE_URL } from "./constants.js";

export type WireProxyResult = {
  claudeCode?: ClaudeProxyResult;
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

/** Claude Code is detected the same way the MCP adapter detects it. */
function claudeCodeInstalled(settingsPath: string): boolean {
  return existsSync(settingsPath) || existsSync(join(homedir(), ".claude"));
}

/**
 * Wire every installed agent to the proxy.
 *
 * Per-agent failures are collected rather than thrown: one agent's
 * broken config file must not stop the other from being wired, and
 * neither should abort `klio init` when the stack itself came up fine.
 */
export function wireProxy(opts: WireProxyOptions): WireProxyResult {
  const result: WireProxyResult = { skipped: [], errors: [] };
  const settingsPath = opts.claudeSettings ?? claudeSettingsPath();

  if (claudeCodeInstalled(settingsPath)) {
    try {
      result.claudeCode = applyProxyEnv({
        settingsPath,
        statePath: opts.statePath,
      });
    } catch (err) {
      result.errors.push({ agent: "claude-code", message: messageOf(err) });
    }
  } else {
    result.skipped.push("claude-code");
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

/** Undo `wireProxy` for every agent. Same per-agent isolation. */
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
 * user who forgot why Remote Control stopped working can re-run init
 * and be told.
 */
export function describeWiring(result: WireProxyResult, log: (line: string) => void): void {
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
  for (const error of result.errors) {
    log(`    ✗ ${error.agent}: ${error.message}`);
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
  log("      • Claude Code does NOT need this. Klio's hooks already cover");
  log("        it end to end — team context is injected at SessionStart,");
  log("        and your sessions are captured from PostToolUse and");
  log("        UserPromptSubmit — and hooks work no matter how Claude Code");
  log("        authenticates. The proxy adds nothing for it.");
  log("        In fact, if you are on a Claude subscription (rather than an");
  log("        ANTHROPIC_API_KEY), Claude Code will not send traffic to a");
  log("        custom base URL at all, so turning the proxy on changes");
  log("        nothing whatsoever for it. Measured, not theorised.");
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
  log("      • MCP Tool Search is disabled by default when the base URL");
  log("        is not Anthropic's. We set ENABLE_TOOL_SEARCH=true to turn");
  log("        it back on. Without that flag you would lose ~85% on tool");
  log("        schemas, so leave it in place.");
  log("");
  log("      • Remote Control (Claude Code v2.1.196+) does NOT work with a");
  log("        custom base URL, and there is no flag that re-enables it.");
  log("        If you use it, run `klio uninit` to undo this wiring.");
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
