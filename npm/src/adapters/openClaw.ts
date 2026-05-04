//
// OpenClaw (https://openclaw.ai) adapter.
//
// OpenClaw exposes a CLI for MCP server registration:
//
//   openclaw mcp set <name> '<json>'      # add or update
//   openclaw mcp unset <name>             # remove
//
// We use the CLI as the primary write path. The CLI manages
// ~/.openclaw/config.json internally; we don't touch the file
// directly when the CLI is available (insulates us against
// schema changes upstream). A file-write fallback exists for
// users whose CLI is missing — see fileWriteFallback() in B3.
//
// Detection: `~/.openclaw/` directory exists.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Adapter, AdapterConfig } from "./types.js";
import { readJson, writeJson } from "./fileutil.js";
import { runProcess, type Spawner } from "./spawner.js";

export type OpenClawAdapterOptions = {
  /** Inject a fake spawner for tests. Defaults to the real one. */
  spawner?: Spawner;
};

export class OpenClawAdapter implements Adapter {
  private readonly spawner: Spawner;

  constructor(opts: OpenClawAdapterOptions = {}) {
    this.spawner = opts.spawner ?? runProcess;
  }

  name(): string {
    return "openclaw";
  }

  private configDir(): string {
    return join(homedir(), ".openclaw");
  }

  installed(): boolean {
    return existsSync(this.configDir());
  }

  async install(cfg: AdapterConfig): Promise<void> {
    const payload = {
      command: "docker",
      args: ["exec", "-i", cfg.bridgeContainer, "klio-mcp"],
      env: cfg.env ?? {},
    };
    try {
      const result = await this.spawner("openclaw", [
        "mcp", "set", "klio",
        JSON.stringify(payload),
      ]);
      if (result.exitCode !== 0) {
        throw new Error(
          `openclaw mcp set failed (exit ${result.exitCode}): ` +
            (result.stderr.trim() || result.stdout.trim()),
        );
      }
      return;
    } catch (err) {
      // ENOENT means the `openclaw` binary isn't on PATH. Fall
      // back to a direct file write — the user has ~/.openclaw/
      // (we wouldn't be here otherwise; installed() returned
      // true) so they have OpenClaw set up but a non-standard
      // CLI install. Write to the documented config path.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      this.fileWriteFallback(payload);
    }
  }

  /**
   * Last-resort install path: write ~/.openclaw/config.json
   * directly. Mirrors the JSON shape OpenClaw's CLI writes
   * internally (mcp.servers.<name>: {command, args, env}).
   *
   * Idempotent — re-running with identical inputs produces a
   * byte-equal file.
   */
  private fileWriteFallback(payload: {
    command: string;
    args: string[];
    env: Record<string, string>;
  }): void {
    const path = join(this.configDir(), "config.json");
    const settings = readJson(path);
    const mcp = (settings["mcp"] as Record<string, unknown> | undefined) ?? {};
    const servers =
      (mcp["servers"] as Record<string, unknown> | undefined) ?? {};
    servers["klio"] = payload;
    mcp["servers"] = servers;
    settings["mcp"] = mcp;
    writeJson(path, settings);
  }

  async uninstall(): Promise<void> {
    const result = await this.spawner("openclaw", [
      "mcp",
      "unset",
      "klio",
    ]);
    if (result.exitCode !== 0) {
      // Best-effort uninstall — don't throw on a missing entry.
    }
  }
}
