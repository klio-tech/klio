// Cursor adapter for the npm-launched flow.
//
// Cursor reads MCP servers from ~/.cursor/mcp.json (user-scoped) and
// .cursor/mcp.json (project-scoped). We patch the user-scoped one so
// klio is available across all projects the user opens.
//
// Cursor ALSO has a separate ~/.cursor/permissions.json that
// pre-approves MCP tools for auto-run, skipping the per-tool
// confirmation dialog. Without this, the user gets a modal the first
// time each klio tool fires (recall, remember, observe, plan, decide,
// note, space). Klio's whole pitch is "memory just works for your
// agents" — having seven approval prompts on first use defeats it.
// We patch permissions.json alongside mcp.json so onboarding finishes
// with zero further configuration on the user's part.

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

export class CursorAdapter implements Adapter {
  name(): string {
    return "cursor";
  }

  private mcpConfigPath(): string {
    return join(homedir(), ".cursor", "mcp.json");
  }

  private permissionsPath(): string {
    return join(homedir(), ".cursor", "permissions.json");
  }

  installed(): boolean {
    // The user-scoped mcp.json is created lazily by Cursor on first
    // server registration, so we test for the parent directory
    // instead. Detecting `~/.cursor` is a strong signal that Cursor
    // is or was installed on this machine.
    return existsSync(join(homedir(), ".cursor"));
  }

  async install(cfg: AdapterConfig): Promise<void> {
    this.patchMcpConfig(cfg);
    this.patchPermissions();
  }

  /**
   * Register klio in ~/.cursor/mcp.json so Cursor connects to the
   * MCP server on next launch. Backup-on-write; peer servers stay
   * untouched.
   */
  private patchMcpConfig(cfg: AdapterConfig): void {
    const path = this.mcpConfigPath();

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

  /**
   * Append klio's 7 MCP tool names to ~/.cursor/permissions.json
   * under `mcp.auto-run` so Cursor stops prompting on each
   * invocation.
   *
   * Tool naming convention in Cursor's auto-run array isn't strictly
   * documented, so we write three variants per tool:
   *   - `klio.<name>`  (server.tool dot — Cursor's most common format)
   *   - `klio_<name>`  (snake-cased — older Cursor builds used this)
   *   - `<name>`       (bare — fallback for very old / undecorated builds)
   *
   * Cursor only acts on the variant it actually parses; the others
   * are ignored. Listing all three guarantees auto-run works across
   * the Cursor versions the user might be on without us pinning to
   * a build-specific string. If Cursor ever changes the format, we
   * add the new variant here and the previous variants remain inert.
   */
  private patchPermissions(): void {
    const path = this.permissionsPath();

    const settings = readJson(path);
    backupFile(path);

    // Read or initialise the mcp.auto-run array. Cursor's docs use
    // the dashed key `auto-run`, not camelCase.
    const mcp =
      (settings["mcp"] as Record<string, unknown> | undefined) ?? {};
    const existing = Array.isArray(mcp["auto-run"]) ? mcp["auto-run"] : [];
    const have = new Set<string>(
      existing.filter((v): v is string => typeof v === "string"),
    );

    for (const fullyQualified of KLIO_MCP_TOOLS) {
      // KLIO_MCP_TOOLS uses Claude Code's `mcp__klio__<tool>` format.
      // Strip the prefix to get the bare tool name, then expand into
      // the three Cursor-shaped variants.
      const bare = fullyQualified.replace(/^mcp__klio__/, "");
      for (const variant of [`klio.${bare}`, `klio_${bare}`, bare]) {
        if (!have.has(variant)) {
          existing.push(variant);
          have.add(variant);
        }
      }
    }

    mcp["auto-run"] = existing;
    settings["mcp"] = mcp;

    writeJson(path, settings);
  }

  async uninstall(): Promise<void> {
    const mcpPath = this.mcpConfigPath();
    const permPath = this.permissionsPath();

    // Restore from backup first; fall back to in-place strip if no
    // backup exists (user may have pruned backups manually).
    if (existsSync(mcpPath)) {
      try {
        restoreFromBackup(mcpPath);
      } catch {
        const settings = readJson(mcpPath);
        const servers = settings["mcpServers"];
        if (servers && typeof servers === "object" && !Array.isArray(servers)) {
          const s = servers as Record<string, unknown>;
          delete s["klio"];
          if (Object.keys(s).length === 0) delete settings["mcpServers"];
          else settings["mcpServers"] = s;
        }
        writeJson(mcpPath, settings);
      }
    }

    if (existsSync(permPath)) {
      try {
        restoreFromBackup(permPath);
      } catch {
        const settings = readJson(permPath);
        const mcp = settings["mcp"];
        if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
          const m = mcp as Record<string, unknown>;
          if (Array.isArray(m["auto-run"])) {
            m["auto-run"] = (m["auto-run"] as unknown[]).filter(
              (v) =>
                typeof v !== "string" ||
                (!v.startsWith("klio.") &&
                  !v.startsWith("klio_") &&
                  !KLIO_MCP_TOOLS.some(
                    (t) => v === t.replace(/^mcp__klio__/, ""),
                  )),
            );
          }
          settings["mcp"] = m;
        }
        writeJson(permPath, settings);
      }
    }
  }
}
