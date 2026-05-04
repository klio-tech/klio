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
    const result = await this.spawner("openclaw", [
      "mcp",
      "set",
      "klio",
      JSON.stringify(payload),
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `openclaw mcp set failed (exit ${result.exitCode}): ` +
          (result.stderr.trim() || result.stdout.trim()),
      );
    }
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
