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
 * init time because both are silent otherwise.
 */
export function describeTradeoffs(log: (line: string) => void): void {
  log("");
  log("    What this changes, and what it costs:");
  log("");
  log("      • Every model call now goes through the local proxy first.");
  log("        This release is PASS-THROUGH ONLY — it forwards traffic");
  log("        unchanged. No compression yet, and no token savings yet.");
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
  log("      • A dead proxy means your agent cannot reach a model at all.");
  log("        A supervisor keeps it alive; `klio doctor` checks and heals.");
  log("");
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
