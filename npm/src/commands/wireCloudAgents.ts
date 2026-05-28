// Cloud-mode agent wiring for `klio init --cloud`.
//
// Where the LOCAL adapters (src/adapters/*) point each agent at the
// in-container bridge over stdio (`docker exec -i klio-bridge
// klio-mcp`) plus six capture hooks, CLOUD mode is dramatically
// simpler: each agent gets a single remote-HTTP MCP entry pointing at
// the hosted brain (CLOUD_MCP_URL) with two headers — `X-Vex-Key`
// (auth) and `X-Vex-Agent` (stable machine id). No hooks. No docker.
// No tools-approval round-trips beyond the existing allowlist behaviour
// we carry over from the local Claude Code adapter.
//
// This module is ADDITIVE: it does NOT touch the local adapters'
// `install()` behaviour. It only reuses their detection (`installed()`)
// and the shared file/CLI/allowlist primitives. The local path remains
// byte-for-byte unchanged.
//
// Coverage: Claude Code, Cursor, and Codex. Any other detected agent
// is skipped cleanly with a note (no cloud writer implemented yet) so
// onboarding never silently drops an agent.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { allAdapters } from "../adapters/types.js";
import { KLIO_MCP_TOOLS } from "../adapters/types.js";
import {
  backupFile,
  readJson,
  writeJson,
} from "../adapters/fileutil.js";
import { upsertMcpServer } from "../adapters/toml.js";
import {
  CLOUD_MCP_URL,
  VEX_AGENT_HEADER,
  VEX_KEY_HEADER,
} from "../cloud.js";

/** Inputs for `wireCloudAgents`. */
export type WireCloudAgentsOptions = {
  /** Verified API key — written as the `X-Vex-Key` header value. */
  apiKey: string;
  /** Stable per-machine id — written as the `X-Vex-Agent` header value. */
  agentId: string;
  /**
   * Single-line writer for user-visible output. Defaults to stdout.
   * Tests pass a capturing array so they can assert on the surfaced
   * lines without touching process state.
   */
  log?: (line: string) => void;
  /**
   * Injectable Claude-CLI runner. Production shells out to the real
   * `claude` binary; tests pass a recording stub so they never spawn a
   * subprocess. Defaults to the real runner.
   */
  claudeCliFn?: ClaudeCliFn;
};

/** Per-agent outcome captured from one `wireCloudAgents` run. */
export type WireCloudAgentsResult = {
  /** Adapter names whose cloud wiring resolved successfully. */
  configured: string[];
  /** Detected adapters with no cloud writer yet — skipped with a note. */
  skipped: string[];
  /** Adapters whose cloud writer threw, with the formatted message. */
  errored: { name: string; message: string }[];
};

/** Shape of the Claude-CLI runner seam. Mirrors `runClaudeCli` in the local adapter. */
export type ClaudeCliFn = (
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultLog = (line: string): void => {
  process.stdout.write(line + "\n");
};

/**
 * Detect installed agents and wire each one to the hosted MCP brain.
 *
 * Reuses `allAdapters().filter(installed())` — the SAME detection the
 * local Phase 4 uses — so cloud mode covers exactly the agents the
 * machine actually has. For each detected agent we dispatch on
 * `name()` to its cloud writer; agents without a writer are recorded
 * in `skipped` and reported, never silently dropped.
 *
 * Returns a result struct rather than printing a phase recap itself,
 * so the caller (initCloud) owns the surrounding UI.
 */
export async function wireCloudAgents(
  opts: WireCloudAgentsOptions,
): Promise<WireCloudAgentsResult> {
  const log = opts.log ?? defaultLog;
  const claudeCliFn = opts.claudeCliFn ?? runClaudeCli;

  const detected = allAdapters().filter((a) => a.installed());
  const configured: string[] = [];
  const skipped: string[] = [];
  const errored: { name: string; message: string }[] = [];

  for (const adapter of detected) {
    const name = adapter.name();
    const writer = CLOUD_WRITERS[name];
    if (!writer) {
      skipped.push(name);
      log(`    — ${name}: cloud wiring not yet supported, skipping`);
      continue;
    }
    try {
      await writer({
        apiKey: opts.apiKey,
        agentId: opts.agentId,
        claudeCliFn,
      });
      configured.push(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errored.push({ name, message });
    }
  }

  return { configured, skipped, errored };
}

/** Arguments handed to each per-agent cloud writer. */
type CloudWriterArgs = {
  apiKey: string;
  agentId: string;
  claudeCliFn: ClaudeCliFn;
};

type CloudWriter = (args: CloudWriterArgs) => Promise<void>;

/**
 * Registry of per-agent cloud writers keyed by `Adapter.name()`. Adding
 * a new agent's cloud support is a one-liner here once its writer
 * exists. Agents absent from this map are reported as "not yet
 * supported" and skipped.
 */
const CLOUD_WRITERS: Record<string, CloudWriter> = {
  "claude-code": writeClaudeCodeCloud,
  cursor: writeCursorCloud,
  codex: writeCodexCloud,
};

// ---------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------

/**
 * Register the hosted brain in Claude Code via the CLI's HTTP
 * transport. We mirror the local adapter's `claude mcp add-json`
 * approach (remove-then-add for idempotency) but emit an HTTP payload:
 *
 *   {"type":"http","url":CLOUD_MCP_URL,"headers":{
 *      "X-Vex-Key":<key>,"X-Vex-Agent":<agent>}}
 *
 * We go through `add-json` rather than `claude mcp add --transport
 * http ...` because the JSON payload lets us attach both headers
 * atomically and is the same shape the local adapter already trusts —
 * one code path, one set of escaping rules.
 *
 * The 7-tool allowlist is carried over from the local adapter so a
 * first-time cloud user doesn't face a permission prompt per klio tool.
 * We patch ONLY permissions.allow in ~/.claude/settings.json (backed
 * up first) — no hooks, unlike the local adapter.
 */
async function writeClaudeCodeCloud(args: CloudWriterArgs): Promise<void> {
  const payload = {
    type: "http",
    url: CLOUD_MCP_URL,
    headers: {
      [VEX_KEY_HEADER]: args.apiKey,
      [VEX_AGENT_HEADER]: args.agentId,
    },
  };

  // `add-json` is not idempotent — it errors when an entry of the same
  // name exists. Remove first (best-effort) then add, so re-running
  // init repairs the entry cleanly.
  try {
    await args.claudeCliFn(["mcp", "remove", "--scope", "user", "klio"]);
  } catch {
    /* ignore — server may not be registered yet */
  }

  const result = await args.claudeCliFn([
    "mcp",
    "add-json",
    "--scope",
    "user",
    "klio",
    JSON.stringify(payload),
  ]);
  if (result.code !== 0) {
    throw new Error(
      `claude mcp add-json failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  patchClaudeAllowList();
}

/**
 * Append klio's 7 MCP tool names to ~/.claude/settings.json
 * permissions.allow if not already present. Backup-on-write; every
 * other key under settings (and the user's prior allow/deny/ask lists)
 * is preserved.
 *
 * A re-implementation of the local adapter's `mergeKlioAllowList`
 * behaviour scoped to the settings file only — we deliberately do NOT
 * import the local adapter's private helper (it also strips legacy
 * mcpServers + writes hooks, neither of which belongs in cloud mode).
 */
function patchClaudeAllowList(): void {
  const path = join(homedir(), ".claude", "settings.json");
  const settings = readJson(path);
  backupFile(path);

  const prev = settings["permissions"];
  const permissions =
    typeof prev === "object" && prev !== null && !Array.isArray(prev)
      ? (prev as Record<string, unknown>)
      : {};

  const existing = Array.isArray(permissions["allow"])
    ? (permissions["allow"] as unknown[])
    : [];
  const have = new Set<string>(
    existing.filter((v): v is string => typeof v === "string"),
  );
  for (const tool of KLIO_MCP_TOOLS) {
    if (have.has(tool)) continue;
    existing.push(tool);
    have.add(tool);
  }
  permissions["allow"] = existing;
  settings["permissions"] = permissions;

  writeJson(path, settings);
}

// ---------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------

/**
 * Patch ~/.cursor/mcp.json so Cursor connects to the hosted brain over
 * HTTP on next launch:
 *
 *   {"mcpServers":{"klio":{
 *      "url":CLOUD_MCP_URL,
 *      "headers":{"X-Vex-Key":<key>,"X-Vex-Agent":<agent>}}}}
 *
 * Backup-on-write; peer servers stay untouched. Reuses the shared
 * read/write/backup helpers from fileutil. No permissions.json patch
 * and no hooks — cloud mode is HTTP-only.
 */
function writeCursorCloud(args: CloudWriterArgs): Promise<void> {
  const path = join(homedir(), ".cursor", "mcp.json");

  const settings = readJson(path);
  backupFile(path);

  const servers =
    (settings["mcpServers"] as Record<string, unknown> | undefined) ?? {};
  servers["klio"] = {
    url: CLOUD_MCP_URL,
    headers: {
      [VEX_KEY_HEADER]: args.apiKey,
      [VEX_AGENT_HEADER]: args.agentId,
    },
  };
  settings["mcpServers"] = servers;

  writeJson(path, settings);
  return Promise.resolve();
}

// ---------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------

/**
 * Patch ~/.codex/config.toml with a remote-HTTP klio MCP server. Codex
 * supports HTTP transports via `url` + `http_headers` keys on the
 * `[mcp_servers.<name>]` table. We render it through the shared
 * `upsertMcpServer` editor by extending the entry shape with the HTTP
 * fields, preserving every other byte of the user's hand-edited file.
 *
 * Backup-on-write (only when a prior config exists). No `[apps.klio]`
 * auto-approval block here — cloud mode keeps the Codex footprint to a
 * single server table; the user can opt into auto-run themselves.
 */
function writeCodexCloud(args: CloudWriterArgs): Promise<void> {
  const path = join(homedir(), ".codex", "config.toml");

  const prior = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existsSync(path)) backupFile(path);

  const next = upsertMcpServer(prior, "klio", {
    url: CLOUD_MCP_URL,
    headers: {
      [VEX_KEY_HEADER]: args.apiKey,
      [VEX_AGENT_HEADER]: args.agentId,
    },
  });

  writeFileSync(path, next, { mode: 0o644 });
  return Promise.resolve();
}

// ---------------------------------------------------------------------
// Claude CLI runner (production default)
// ---------------------------------------------------------------------

/**
 * Spawn the real `claude` CLI. Mirrors the local adapter's runner so
 * cloud + local share identical error semantics (ENOENT → install
 * hint). Tests never reach this — they inject `claudeCliFn`.
 */
function runClaudeCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", (err) => {
      reject(
        new Error(
          "`claude` CLI not found on PATH; install Claude Code " +
            `(https://claude.ai/code) then re-run klio init: ${err.message}`,
        ),
      );
    });
    child.on("exit", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}
