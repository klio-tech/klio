// OpenCode (SST's open-source AI coding agent) adapter.
//
// Config lives at:
//   $XDG_CONFIG_HOME/opencode/opencode.json   (if XDG_CONFIG_HOME set)
//   ~/.config/opencode/opencode.json          (POSIX default)
//
// Schema (per https://opencode.ai/docs/mcp-servers):
//
//   {
//     "$schema": "https://opencode.ai/config.json",
//     "mcp": {
//       "klio": {
//         "type": "local",
//         "command": ["docker", "exec", "-i", "klio-bridge", "klio-mcp"],
//         "enabled": true
//       }
//     }
//   }
//
// Note the shape diff vs. Claude/Cursor/Codex: `command` is a SINGLE
// ARRAY (process + args together), not separate `command` string +
// `args` array. Tests pin this exactly.

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

export class OpenCodeAdapter implements Adapter {
  name(): string {
    return "opencode";
  }

  private configDir(): string {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg) return join(xdg, "opencode");
    return join(homedir(), ".config", "opencode");
  }

  private configPath(): string {
    return join(this.configDir(), "opencode.json");
  }

  installed(): boolean {
    return existsSync(this.configDir());
  }

  async install(cfg: AdapterConfig): Promise<void> {
    const path = this.configPath();
    const settings = readJson(path);
    backupFile(path);

    const mcp =
      (settings["mcp"] as Record<string, unknown> | undefined) ?? {};

    const entry: Record<string, unknown> = {
      type: "local",
      command: ["docker", "exec", "-i", cfg.bridgeContainer, "klio-mcp"],
      enabled: true,
    };
    if (Object.keys(cfg.env).length > 0) {
      // OpenCode's docs use `environment`, not `env`, for the env-var
      // map on local servers.
      entry["environment"] = cfg.env;
    }
    mcp["klio"] = entry;

    settings["mcp"] = mcp;
    // Preserve / add the schema reference if absent.
    if (!settings["$schema"]) {
      settings["$schema"] = "https://opencode.ai/config.json";
    }

    writeJson(path, settings);
  }

  async uninstall(): Promise<void> {
    const path = this.configPath();
    if (!existsSync(path)) return;
    try {
      restoreFromBackup(path);
      return;
    } catch {
      // No backup — fall through to in-place strip.
    }
    const settings = readJson(path);
    const mcp = settings["mcp"];
    if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
      const m = mcp as Record<string, unknown>;
      delete m["klio"];
      if (Object.keys(m).length === 0) delete settings["mcp"];
      else settings["mcp"] = m;
    }
    writeJson(path, settings);
  }
}
