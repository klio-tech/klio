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
// Coverage: Claude Code, Cursor, Codex, Claude Desktop, OpenCode, and
// OpenClaw. Agents whose config can speak remote-HTTP-with-headers
// natively (Cursor, Codex, OpenCode) get a direct HTTP MCP entry;
// agents that only accept stdio servers (Claude Desktop, OpenClaw) get
// an `mcp-remote` stdio bridge that forwards both auth headers upstream.
// Claude Code uses its own CLI's `http` transport. Any other detected
// agent is skipped cleanly with a note (no cloud writer implemented
// yet) so onboarding never silently drops an agent.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
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
  mcpRemoteBridge,
  perToolAgentId,
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
        // Tag each tool with a distinct `<machineId>/<tool>` agent id so the
        // hosted brain can attribute provenance per tool. The writer's
        // `args.agentId` flows straight into its header / mcp-remote bridge,
        // so this single substitution covers every adapter uniformly.
        agentId: perToolAgentId(opts.agentId, name),
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
  "claude-desktop": writeClaudeDesktopCloud,
  opencode: writeOpenCodeCloud,
  openclaw: writeOpenClawCloud,
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
 * up first), STRIP any lingering local-mode klio hooks (the six
 * `docker exec ... klio hook ...` entries a prior `klio init` wrote),
 * and then INSTALL the four cloud capture hooks (SessionStart /
 * UserPromptSubmit / PostToolUse / Stop) that point at
 * `npx -y @klio-tech/klio hook <subcmd>` — the thin passive-capture
 * client (src/commands/hook.ts).
 * Strip-then-install keeps re-runs idempotent (the new cloud commands
 * also contain the `klio hook` marker, so the strip clears a prior
 * cloud install too before we re-add).
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

  patchClaudeSettings();
}

/**
 * Single backup + read + write pass over ~/.claude/settings.json that
 * (1) appends klio's 7 MCP tool names to permissions.allow and
 * (2) strips any lingering local-mode klio hooks. Both edits share one
 * backup and one write so a cloud re-run touches the file at most once.
 *
 * permissions: a re-implementation of the local adapter's
 * `mergeKlioAllowList` scoped to the settings file only — we
 * deliberately do NOT import the local adapter's private helper (it
 * also strips legacy mcpServers + WRITES hooks, neither of which
 * belongs in cloud mode).
 *
 * hooks: `stripKlioHooks` then `installCloudHooks` — clear any prior
 * klio hooks (local docker OR a prior cloud install) and write the four
 * cloud capture hooks fresh, so a re-run converges to exactly one set.
 */
function patchClaudeSettings(): void {
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

  stripKlioHooks(settings);
  installCloudHooks(settings);

  writeJson(path, settings);
}

/**
 * The four Claude Code lifecycle events cloud mode captures, mapped to
 * the `klio hook` subcommand the thin client (src/commands/hook.ts)
 * normalizes. A SUBSET of the local adapter's six hooks: cloud still
 * skips PreToolUse (a recall round-trip per tool call) and SubagentStop,
 * but DOES capture PostToolUse — the server stores that observation via
 * embedding alone (no chat LLM), so it's cheap and restores parity with
 * the local bridge's cross-agent tool visibility. The Stop transcript
 * ingest remains the primary distillation pass.
 */
const CLOUD_HOOK_DEFS: { event: string; matcher: string; subcmd: string }[] = [
  { event: "SessionStart", matcher: "*", subcmd: "session-start" },
  { event: "UserPromptSubmit", matcher: "*", subcmd: "user-prompt" },
  { event: "PostToolUse", matcher: "*", subcmd: "post-tool" },
  { event: "Stop", matcher: "*", subcmd: "session-stop" },
];

/**
 * Command each cloud hook runs. `npx -y` resolves+runs the published CLI
 * without a global install (the same portability the `mcp-remote` bridge
 * relies on), so a cloud user who onboarded via `npx @klio-tech/klio init`
 * doesn't need `klio` on PATH for hooks to fire.
 */
const CLOUD_HOOK_COMMAND_PREFIX = "npx -y @klio-tech/klio hook";

/**
 * Append Klio's four cloud capture hooks to a Claude Code settings
 * object in place, preserving any non-Klio hooks. MUST run AFTER
 * `stripKlioHooks` (which clears prior klio entries, including a prior
 * cloud install), so this only ever adds — never duplicates. A fresh
 * machine materialises the `hooks` key; a machine with peer hooks keeps
 * them and gains our blocks alongside.
 */
function installCloudHooks(settings: Record<string, unknown>): void {
  const prev = settings["hooks"];
  const hooks =
    typeof prev === "object" && prev !== null && !Array.isArray(prev)
      ? (prev as Record<string, unknown>)
      : {};

  for (const def of CLOUD_HOOK_DEFS) {
    const block = {
      matcher: def.matcher,
      hooks: [
        { type: "command", command: `${CLOUD_HOOK_COMMAND_PREFIX} ${def.subcmd}` },
      ],
    };
    const existing = Array.isArray(hooks[def.event])
      ? (hooks[def.event] as unknown[])
      : [];
    existing.push(block);
    hooks[def.event] = existing;
  }

  settings["hooks"] = hooks;
}

/**
 * Remove Klio's capture hooks from a Claude Code settings object in
 * place, leaving every non-Klio hook intact.
 *
 * A prior LOCAL `klio init` writes six hook entries whose command is
 * `docker exec -i <container> klio hook <subcmd>` across the
 * SessionStart / UserPromptSubmit / PreToolUse / PostToolUse /
 * SubagentStop / Stop events. Once a user switches to cloud mode and
 * stops Docker, those commands fail on every event. We match a hook
 * entry as "Klio's" when its `command` string mentions either
 * `klio hook` (the subcommand the local adapter writes) or
 * `klio-bridge` (the default bridge container name) — both are
 * Klio-specific and won't collide with a user's own hooks.
 *
 * We prune matching entries from each event's matcher blocks, drop a
 * block once its `hooks` array is empty, drop an event once it has no
 * blocks, and drop the top-level `hooks` key once it's empty — so the
 * file is left exactly as it would be had Klio never written hooks.
 * No-op when there are no hooks at all (fresh machine).
 */
function stripKlioHooks(settings: Record<string, unknown>): void {
  const hooks = settings["hooks"];
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    return;
  }
  const hookMap = hooks as Record<string, unknown>;

  for (const event of Object.keys(hookMap)) {
    const blocks = hookMap[event];
    if (!Array.isArray(blocks)) continue;

    const keptBlocks: unknown[] = [];
    for (const block of blocks) {
      if (typeof block !== "object" || block === null || Array.isArray(block)) {
        keptBlocks.push(block);
        continue;
      }
      const b = block as Record<string, unknown>;
      const entries = b["hooks"];
      if (!Array.isArray(entries)) {
        keptBlocks.push(block);
        continue;
      }
      const keptEntries = entries.filter((entry) => !isKlioHookEntry(entry));
      if (keptEntries.length === 0) continue; // whole block was Klio's
      keptBlocks.push({ ...b, hooks: keptEntries });
    }

    if (keptBlocks.length === 0) delete hookMap[event];
    else hookMap[event] = keptBlocks;
  }

  if (Object.keys(hookMap).length === 0) delete settings["hooks"];
  else settings["hooks"] = hookMap;
}

/**
 * True when a single hook entry's `command` is one Klio wrote in local
 * mode — identified by the `klio hook` subcommand marker or the
 * `klio-bridge` container name. Non-string / malformed entries are
 * never treated as Klio's (we preserve anything we don't recognise).
 */
function isKlioHookEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return false;
  }
  const command = (entry as Record<string, unknown>)["command"];
  if (typeof command !== "string") return false;
  return command.includes("klio hook") || command.includes("klio-bridge");
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
// Claude Desktop
// ---------------------------------------------------------------------

/**
 * Patch Claude Desktop's `claude_desktop_config.json` so the desktop
 * app reaches the hosted brain on next launch.
 *
 * Claude Desktop's config only understands STDIO MCP servers
 * (`{command, args}` under `mcpServers`) — it has no native
 * remote-HTTP-with-headers transport. So we register an `mcp-remote`
 * stdio bridge that forwards both auth headers upstream:
 *
 *   "klio": { "command": "npx", "args": ["-y","mcp-remote",
 *      CLOUD_MCP_URL,"--header","X-Vex-Key: <key>",
 *      "--header","X-Vex-Agent: <agent>"] }
 *
 * The config path is resolved per-OS exactly as the local
 * ClaudeDesktopAdapter does (macOS Application Support, Windows
 * APPDATA, else XDG). Backup-on-write; peer mcpServers untouched;
 * re-running replaces only the `klio` entry.
 */
function writeClaudeDesktopCloud(args: CloudWriterArgs): Promise<void> {
  const path = claudeDesktopConfigPath();

  const settings = readJson(path);
  backupFile(path);

  const servers =
    (settings["mcpServers"] as Record<string, unknown> | undefined) ?? {};
  servers["klio"] = mcpRemoteBridge(args.apiKey, args.agentId);
  settings["mcpServers"] = servers;

  writeJson(path, settings);
  return Promise.resolve();
}

/**
 * Per-OS Claude Desktop config path. Mirrors
 * ClaudeDesktopAdapter.configPath so cloud + local agree byte-for-byte
 * on where the file lives.
 */
function claudeDesktopConfigPath(): string {
  const p = platform();
  if (p === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  }
  if (p === "win32") {
    const appData = process.env.APPDATA;
    const dir = appData
      ? join(appData, "Claude")
      : join(homedir(), "AppData", "Roaming", "Claude");
    return join(dir, "claude_desktop_config.json");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const dir = xdg ? join(xdg, "Claude") : join(homedir(), ".config", "Claude");
  return join(dir, "claude_desktop_config.json");
}

// ---------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------

/**
 * Patch OpenCode's `opencode.json` with a native remote MCP entry.
 *
 * OpenCode supports remote-HTTP MCP servers directly via a
 * `{type:"remote", url, headers, enabled}` shape under the top-level
 * `mcp` key (per https://opencode.ai/docs/mcp-servers), so — unlike
 * Claude Desktop — no `mcp-remote` bridge is needed:
 *
 *   "mcp": { "klio": { "type":"remote", "url":CLOUD_MCP_URL,
 *      "enabled":true, "headers":{
 *        "X-Vex-Key":<key>,"X-Vex-Agent":<agent>}}}
 *
 * Note the `mcp` key (OpenCode's own) vs. `mcpServers` (Claude/Cursor)
 * — matched from the local OpenCodeAdapter. Config path honours
 * $XDG_CONFIG_HOME. Backup-on-write; peer servers + `$schema`
 * preserved; re-running replaces only the `klio` entry.
 */
function writeOpenCodeCloud(args: CloudWriterArgs): Promise<void> {
  const xdg = process.env.XDG_CONFIG_HOME;
  const dir = xdg ? join(xdg, "opencode") : join(homedir(), ".config", "opencode");
  const path = join(dir, "opencode.json");

  const settings = readJson(path);
  backupFile(path);

  const mcp = (settings["mcp"] as Record<string, unknown> | undefined) ?? {};
  mcp["klio"] = {
    type: "remote",
    url: CLOUD_MCP_URL,
    enabled: true,
    headers: {
      [VEX_KEY_HEADER]: args.apiKey,
      [VEX_AGENT_HEADER]: args.agentId,
    },
  };
  settings["mcp"] = mcp;
  if (!settings["$schema"]) {
    settings["$schema"] = "https://opencode.ai/config.json";
  }

  writeJson(path, settings);
  return Promise.resolve();
}

// ---------------------------------------------------------------------
// OpenClaw
// ---------------------------------------------------------------------

/**
 * Patch OpenClaw's `~/.openclaw/config.json` with an `mcp-remote`
 * stdio bridge to the hosted brain.
 *
 * OpenClaw's config (and its `openclaw mcp set` CLI) declares MCP
 * servers in the STDIO shape `mcp.servers.<name>: {command, args, env}`
 * — the local OpenClawAdapter writes exactly that — with no documented
 * remote-HTTP-with-headers transport. So, like Claude Desktop, we
 * register an `mcp-remote` bridge that carries both auth headers:
 *
 *   "mcp": { "servers": { "klio": { "command":"npx", "args":[
 *      "-y","mcp-remote",CLOUD_MCP_URL,
 *      "--header","X-Vex-Key: <key>",
 *      "--header","X-Vex-Agent: <agent>"] }}}
 *
 * We write the config file directly (rather than shelling out to the
 * `openclaw` CLI) to keep the cloud path subprocess-free and
 * deterministic in tests — the JSON shape matches the adapter's
 * documented file-write fallback. Backup-on-write; peer servers
 * untouched; re-running replaces only the `klio` entry.
 */
function writeOpenClawCloud(args: CloudWriterArgs): Promise<void> {
  const path = join(homedir(), ".openclaw", "config.json");

  const settings = readJson(path);
  backupFile(path);

  const mcp = (settings["mcp"] as Record<string, unknown> | undefined) ?? {};
  const servers =
    (mcp["servers"] as Record<string, unknown> | undefined) ?? {};
  servers["klio"] = mcpRemoteBridge(args.apiKey, args.agentId);
  mcp["servers"] = servers;
  settings["mcp"] = mcp;

  writeJson(path, settings);
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
