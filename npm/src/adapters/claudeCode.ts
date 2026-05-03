// Claude Code adapter for the npm-launched flow.
//
// Same shape as bridge/internal/agentadapters/claude_code.go, but
// every command we write into settings.json points at
// `docker exec -i klio-bridge ...` instead of a host binary path.
// That's the central trick that lets the npm package ship with no
// platform-specific binaries: Claude Code spawns docker, docker
// reaches into the container, the container runs the real `klio`
// (Go) which talks to the daemon via the in-container unix socket.
//
// The MCP server is registered via Claude's own CLI (`claude mcp
// add-json`) for the same reason we do it in the Go adapter:
// ~/.claude.json holds 100KB+ of unrelated state and parsing/
// rewriting it ourselves is brittle across Claude Code versions.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Adapter, AdapterConfig } from "./types.js";
import { KLIO_MCP_TOOLS } from "./types.js";
import {
  backupFile,
  readJson,
  restoreFromBackup,
  writeJson,
} from "./fileutil.js";

const HOOK_DEFINITIONS = [
  { event: "SessionStart", matcher: "*", subcmd: "session-start" },
  { event: "UserPromptSubmit", matcher: "*", subcmd: "user-prompt" },
  { event: "PreToolUse", matcher: "Bash|Edit|Write", subcmd: "pre-tool" },
  { event: "PostToolUse", matcher: "*", subcmd: "post-tool" },
  { event: "SubagentStop", matcher: "*", subcmd: "subagent-stop" },
  { event: "Stop", matcher: "*", subcmd: "session-stop" },
] as const;

export class ClaudeCodeAdapter implements Adapter {
  name(): string {
    return "claude-code";
  }

  private settingsPath(): string {
    return join(homedir(), ".claude", "settings.json");
  }

  installed(): boolean {
    if (existsSync(this.settingsPath())) return true;
    if (existsSync(join(homedir(), ".claude"))) return true;
    return false;
  }

  async install(cfg: AdapterConfig): Promise<void> {
    await this.registerMcp(cfg);
    this.patchHooks(cfg);
  }

  async uninstall(): Promise<void> {
    // Best-effort MCP removal first — even if the `claude` CLI is
    // missing we still want to attempt the settings.json restore.
    try {
      await runClaudeCli(["mcp", "remove", "--scope", "user", "klio"]);
    } catch {
      /* ignore */
    }
    try {
      restoreFromBackup(this.settingsPath());
    } catch {
      /* no backup → leave settings.json alone */
    }
  }

  /**
   * Register the klio MCP server via `claude mcp add-json`. We call
   * the CLI rather than editing ~/.claude.json directly because:
   *   - That file holds 100KB+ of state (project bookmarks, telemetry)
   *     unrelated to MCP; manual JSON merges risk corruption across
   *     Claude Code versions.
   *   - The CLI knows the canonical path + scope rules.
   *
   * The command we register is `docker exec -i <container> klio-mcp`
   * — Claude Code spawns it as the MCP server, the container runs
   * the real Go MCP shim, the shim talks to the daemon over the
   * in-container unix socket.
   */
  private async registerMcp(cfg: AdapterConfig): Promise<void> {
    const payload = {
      command: "docker",
      args: ["exec", "-i", cfg.bridgeContainer, "klio-mcp"],
      env: cfg.env,
    };

    // `claude mcp add-json` is NOT idempotent — it errors when an
    // entry with the same name already exists. Remove first
    // (best-effort, ignore failure if missing) then add. The pair
    // is atomic from Klio's perspective.
    try {
      await runClaudeCli(["mcp", "remove", "--scope", "user", "klio"]);
    } catch {
      /* ignore — server may not be registered yet */
    }

    const result = await runClaudeCli([
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
  }

  /**
   * Patch ~/.claude/settings.json with:
   *   - the six event hooks pointing at the docker-exec command
   *   - permissions.allow entries for the 7 klio MCP tools
   *   - cleanup of legacy mcpServers.klio entries from older versions
   *
   * Re-running with identical config produces an unchanged file
   * (modulo the timestamped backup we always create).
   */
  private patchHooks(cfg: AdapterConfig): void {
    const path = this.settingsPath();
    const settings = readJson(path);
    backupFile(path);

    // Drop legacy mcpServers.klio (the MCP server lives in
    // ~/.claude.json, not here, so any entry here is inert).
    const mcp = settings["mcpServers"];
    if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
      const m = mcp as Record<string, unknown>;
      delete m["klio"];
      if (Object.keys(m).length === 0) delete settings["mcpServers"];
      else settings["mcpServers"] = m;
    }

    const hooks =
      (settings["hooks"] as Record<string, unknown> | undefined) ?? {};

    for (const def of HOOK_DEFINITIONS) {
      const command = `docker exec -i ${cfg.bridgeContainer} klio hook ${def.subcmd}`;
      setHook(hooks, def.event, def.matcher, command, cfg.env);
    }
    settings["hooks"] = hooks;

    settings["permissions"] = mergeKlioAllowList(settings["permissions"]);

    writeJson(path, settings);
  }
}

// ---- helpers ----

type HookEntry = {
  type: "command";
  command: string;
  env?: Record<string, string>;
};

type HookBlock = {
  matcher: string;
  hooks: HookEntry[];
};

/**
 * Insert/replace a single hook entry under (event, matcher). Strips
 * any prior entry whose command ends with " hook <subcmd>", even if
 * the binary prefix differs — keeps re-installs idempotent across
 * binary path changes (e.g. user previously ran a host-side klio
 * and now switched to the docker-exec form).
 */
function setHook(
  hooks: Record<string, unknown>,
  event: string,
  matcher: string,
  command: string,
  env: Record<string, string>,
): void {
  const idx = command.lastIndexOf(" hook ");
  const hookSuffix = idx >= 0 ? command.slice(idx) : "";

  const newEntry: HookEntry = {
    type: "command",
    command,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };

  const existing = (hooks[event] as HookBlock[] | undefined) ?? [];
  for (const block of existing) {
    if (block.matcher !== matcher) continue;
    block.hooks = (block.hooks ?? []).filter((h) => {
      if (typeof h !== "object" || h === null) return false;
      return !(hookSuffix && (h as HookEntry).command?.endsWith(hookSuffix));
    });
    block.hooks.push(newEntry);
    hooks[event] = existing;
    return;
  }
  existing.push({ matcher, hooks: [newEntry] });
  hooks[event] = existing;
}

/**
 * Append klio's MCP tool names to permissions.allow if not already
 * present. Preserves user's prior allow/deny/ask lists and any
 * other keys under permissions.
 */
function mergeKlioAllowList(prev: unknown): Record<string, unknown> {
  const out =
    (typeof prev === "object" && prev !== null && !Array.isArray(prev)
      ? (prev as Record<string, unknown>)
      : {}) ?? {};

  const existing = Array.isArray(out["allow"]) ? (out["allow"] as unknown[]) : [];
  const have = new Set<string>(
    existing.filter((v): v is string => typeof v === "string"),
  );
  for (const tool of KLIO_MCP_TOOLS) {
    if (have.has(tool)) continue;
    existing.push(tool);
    have.add(tool);
  }
  out["allow"] = existing;
  return out;
}

async function runClaudeCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", (err) => {
      // ENOENT on macOS/Linux when claude isn't on PATH.
      reject(
        new Error(
          `\`claude\` CLI not found on PATH; install Claude Code (https://claude.ai/code) ` +
            `then re-run klio init: ${err.message}`,
        ),
      );
    });
    child.on("exit", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}
