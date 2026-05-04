// Shared shape for agent adapters. Mirrors the Go agentadapters.Adapter
// interface so the two implementations stay in lockstep — if we add a
// new agent (Codex CLI, Continue, etc.) we should add the adapter
// in BOTH languages so users get the same coverage regardless of which
// `klio init` entry point they used.

import { ClaudeCodeAdapter } from "./claudeCode.js";
import { ClaudeDesktopAdapter } from "./claudeDesktop.js";
import { CodexAdapter } from "./codex.js";
import { CursorAdapter } from "./cursor.js";
import { OpenClawAdapter } from "./openClaw.js";
import { OpenCodeAdapter } from "./openCode.js";

export type AdapterConfig = {
  /**
   * Container name the bridge runs under. Used as `docker exec
   * <container> ...`. Defaults to "klio-bridge" but the npm launcher
   * passes it explicitly so a future "named profile" feature (e.g.
   * `klio init --profile work` running a parallel stack) can target
   * the right bridge.
   */
  bridgeContainer: string;

  /**
   * Environment variables to attach to every hook/MCP-server entry
   * the adapter writes. The npm launcher always sets at least
   * KLIO_DOCKER_BRIDGE so debugging is easier ("which klio is this
   * agent talking to?" — read the env block in settings.json).
   */
  env: Record<string, string>;
};

export interface Adapter {
  /** Stable identifier — used for status reporting + telemetry. */
  name(): string;

  /** True when the agent's config files exist on this machine. */
  installed(): boolean;

  /** Backup + patch the agent's config to add Klio. Idempotent. */
  install(cfg: AdapterConfig): Promise<void>;

  /** Restore the agent's config from the most recent backup. */
  uninstall(): Promise<void>;
}

/**
 * The canonical list of agent adapters Klio knows how to wire. Both
 * `klio init` and `klio uninstall` iterate this list and skip any
 * adapter whose `installed()` returns false. Adding a new agent is
 * therefore a one-liner here, not a multi-file edit across commands.
 *
 * Order matters only for status output (we list them top-to-bottom
 * in this order); the install/uninstall side effects of each adapter
 * are independent.
 */
export function allAdapters(): Adapter[] {
  return [
    new ClaudeCodeAdapter(),
    new ClaudeDesktopAdapter(),
    new CursorAdapter(),
    new CodexAdapter(),
    new OpenCodeAdapter(),
    new OpenClawAdapter(),
  ];
}

/**
 * The 7 MCP tool names the dispatcher exposes. Used to auto-allowlist
 * them in Claude Code's permissions.allow so first-time users don't
 * face a prompt for every klio tool.
 *
 * MUST match bridge/internal/mcp/dispatcher.go.
 */
export const KLIO_MCP_TOOLS = [
  "mcp__klio__recall",
  "mcp__klio__remember",
  "mcp__klio__observe",
  "mcp__klio__plan",
  "mcp__klio__decide",
  "mcp__klio__note",
  "mcp__klio__space",
];
