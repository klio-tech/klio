// Codex (OpenAI Codex CLI) adapter for the npm-launched flow.
//
// Codex reads MCP server registrations from `~/.codex/config.toml`
// under `[mcp_servers.<name>]` tables. The file is hand-edited by
// users (it also holds non-MCP settings like model defaults), so we
// must not round-trip it through a generic TOML library — that would
// drop comments, blank lines, and stable key ordering.
//
// We instead rely on `./toml.ts`, a hand-rolled minimal reader/writer
// scoped to the Codex MCP subset. It locates the [mcp_servers.<name>]
// block (and any [mcp_servers.<name>.env] sub-table) by line scan
// and rewrites only that slice, preserving every other byte of the
// file.
//
// Detection: we test for the existence of the `~/.codex` directory
// rather than the file itself. Codex creates `config.toml` lazily
// on first config write, so requiring the file would incorrectly
// report Codex as "not installed" for fresh installations.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Adapter, AdapterConfig } from "./types.js";
import { backupFile, restoreFromBackup } from "./fileutil.js";
import { removeMcpServer, upsertMcpServer } from "./toml.js";

export class CodexAdapter implements Adapter {
  name(): string {
    return "codex";
  }

  private codexDir(): string {
    return join(homedir(), ".codex");
  }

  private configPath(): string {
    return join(this.codexDir(), "config.toml");
  }

  installed(): boolean {
    // The directory is the install marker — config.toml may not
    // exist yet on a fresh Codex setup.
    return existsSync(this.codexDir());
  }

  async install(cfg: AdapterConfig): Promise<void> {
    const path = this.configPath();
    const prior = existsSync(path) ? readFileSync(path, "utf8") : "";

    // Only back up when there's something to restore. backupFile is
    // already a no-op for missing paths, but checking explicitly
    // keeps the intent clear and avoids polluting the directory
    // with empty backup files for new installs.
    if (existsSync(path)) backupFile(path);

    const next = upsertMcpServer(prior, "klio", {
      command: "docker",
      args: ["exec", "-i", cfg.bridgeContainer, "klio-mcp"],
      env: cfg.env,
    });

    writeFileSync(path, next, { mode: 0o644 });
  }

  async uninstall(): Promise<void> {
    const path = this.configPath();
    if (!existsSync(path)) return;

    try {
      restoreFromBackup(path);
      return;
    } catch {
      // No backup found — fall through to in-place strip. Partial
      // cleanup beats a hard failure when the user has pruned
      // backup files.
    }

    const stripped = removeMcpServer(readFileSync(path, "utf8"), "klio");
    writeFileSync(path, stripped, { mode: 0o644 });
  }
}
