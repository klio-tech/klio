// Cursor adapter for the npm-launched flow.
//
// Cursor reads MCP servers from ~/.cursor/mcp.json (user-scoped) and
// .cursor/mcp.json (project-scoped). We patch the user-scoped one
// so klio is available across all projects the user opens.
//
// Same shape as the Go-side CursorAdapter; the only difference is
// the command we register: `docker exec -i klio-bridge klio-mcp`
// instead of an absolute host binary path.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Adapter, AdapterConfig } from "./types.js";
import {
  backupFile,
  readJson,
  restoreFromBackup,
  writeJson,
} from "./fileutil.js";

export class CursorAdapter implements Adapter {
  name(): string {
    return "cursor";
  }

  private configPath(): string {
    return join(homedir(), ".cursor", "mcp.json");
  }

  installed(): boolean {
    // The user-scoped mcp.json is created lazily by Cursor on first
    // server registration, so we test for the parent directory
    // instead. Detecting `~/.cursor` is a strong signal that Cursor
    // is or was installed on this machine.
    return existsSync(join(homedir(), ".cursor"));
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
      // Backup missing — strip in place rather than fail. Partial
      // cleanup is better than no cleanup if the user pruned
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
