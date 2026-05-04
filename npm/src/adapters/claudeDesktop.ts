// Claude Desktop adapter for the npm-launched flow.
//
// Claude Desktop is Anthropic's installable chat app — distinct from
// Claude Code (the CLI/IDE). It supports local STDIO MCP servers via
// a single JSON config file:
//
//   macOS    ~/Library/Application Support/Claude/claude_desktop_config.json
//   Windows  %APPDATA%/Claude/claude_desktop_config.json
//   Linux    ~/.config/Claude/claude_desktop_config.json
//
// The schema mirrors Cursor's `mcp.json` exactly:
//
//   { "mcpServers": { "klio": { "command": "docker", "args": [...] } } }
//
// Both Claude Chat and Claude Cowork (in Claude Desktop) read this
// same file. Patching it once enables klio in both UI modes — and is
// the difference between the user's Cowork session "seeing" klio vs.
// hallucinating that it doesn't exist (which is what happened before
// 0.3.6 — see the 2026-05-04 Cowork debugging thread).
//
// Detection: the directory exists if Claude Desktop has been launched
// at least once. We check the parent directory rather than the file
// because Claude Desktop creates the JSON lazily on first MCP write
// — a fresh install with no MCP servers yet has the dir but no file.

import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import type { Adapter, AdapterConfig } from "./types.js";
import {
  backupFile,
  readJson,
  restoreFromBackup,
  writeJson,
} from "./fileutil.js";

export class ClaudeDesktopAdapter implements Adapter {
  name(): string {
    return "claude-desktop";
  }

  /**
   * Resolve the Claude Desktop config directory for this OS. We
   * resolve once (not memoised) — the cost is one homedir() + one
   * platform() per call, both negligible.
   */
  private configDir(): string {
    const p = platform();
    if (p === "darwin") {
      return join(homedir(), "Library", "Application Support", "Claude");
    }
    if (p === "win32") {
      // APPDATA on Windows is the per-user roaming config root. Fall
      // back to the conventional path under homedir() if APPDATA
      // isn't set (rare — would mean a corrupt user profile).
      const appData = process.env.APPDATA;
      if (appData) return join(appData, "Claude");
      return join(homedir(), "AppData", "Roaming", "Claude");
    }
    // Linux + everything else: XDG-style config root. Honour
    // XDG_CONFIG_HOME if the user has overridden the default.
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg) return join(xdg, "Claude");
    return join(homedir(), ".config", "Claude");
  }

  private configPath(): string {
    return join(this.configDir(), "claude_desktop_config.json");
  }

  installed(): boolean {
    return existsSync(this.configDir());
  }

  async install(cfg: AdapterConfig): Promise<void> {
    const path = this.configPath();

    const settings = readJson(path);
    backupFile(path);

    const servers =
      (settings["mcpServers"] as Record<string, unknown> | undefined) ?? {};

    servers["klio"] = {
      command: "docker",
      args: ["exec", "-i", cfg.bridgeContainer, "klio-mcp"],
      env: cfg.env,
    };
    settings["mcpServers"] = servers;

    writeJson(path, settings);
  }

  async uninstall(): Promise<void> {
    const path = this.configPath();
    if (!existsSync(path)) return;

    try {
      restoreFromBackup(path);
      return;
    } catch {
      // No backup — fall through to in-place strip. Partial cleanup
      // is better than a hard failure when the user has pruned
      // backup files.
    }

    const settings = readJson(path);
    const servers = settings["mcpServers"];
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      const s = servers as Record<string, unknown>;
      delete s["klio"];
      if (Object.keys(s).length === 0) delete settings["mcpServers"];
      else settings["mcpServers"] = s;
    }
    writeJson(path, settings);
  }
}
