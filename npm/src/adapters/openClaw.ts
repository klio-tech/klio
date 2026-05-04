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
// users whose CLI is missing — see fileWriteFallback() below.
//
// Detection: `~/.openclaw/` directory exists.
//
// Detection narrowing: the original design considered detecting
// the `openclaw` CLI on PATH as an additional signal so users
// who installed OpenClaw but never ran it (no config dir yet)
// would still register. We dropped that path because PATH probing
// requires an async spawner call, which would force the Adapter
// interface's `installed()` to become async — a cross-cutting
// change to all five existing adapters for an edge case (most
// users run OpenClaw at least once before installing klio). The
// directory-only signal is good enough in practice; users in the
// PATH-only state can re-run `klio init` after their first
// OpenClaw launch and the adapter will detect them.

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

  private configPath(): string {
    return join(this.configDir(), "config.json");
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
   * Backs up any pre-existing config to a timestamped file before
   * writing — uninstall's fallback path then restores it. Without
   * the backup, a user-edited config could be silently overwritten
   * by an install that ran on a machine missing the CLI.
   *
   * Idempotent — re-running with identical inputs produces a
   * byte-equal file.
   */
  private fileWriteFallback(payload: {
    command: string;
    args: string[];
    env: Record<string, string>;
  }): void {
    const path = this.configPath();
    backupFile(path);
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
    try {
      const result = await this.spawner("openclaw", [
        "mcp",
        "unset",
        "klio",
      ]);
      if (result.exitCode !== 0) {
        // Best-effort uninstall — non-zero typically means the
        // entry was already absent. Don't throw; init.ts wraps
        // adapter uninstalls in try/catch anyway and a noisy
        // failure here would mask other adapters' cleanup.
        return;
      }
    } catch (err) {
      // ENOENT mirrors the install path: the CLI is gone but the
      // user likely installed via fallback, so undo via the file
      // path. Restore from backup if one exists, else strip the
      // klio entry in place. Non-ENOENT errors propagate — those
      // indicate a genuine failure the caller should see.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      this.fileWriteFallbackUninstall();
    }
  }

  /**
   * Reverse of `fileWriteFallback`. Try restoreFromBackup first
   * (recovers the pre-install user-edited content); if no backup
   * exists, strip the klio entry in place so peer servers stay.
   */
  private fileWriteFallbackUninstall(): void {
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
      const servers = m["servers"];
      if (servers && typeof servers === "object" && !Array.isArray(servers)) {
        const s = servers as Record<string, unknown>;
        delete s["klio"];
        if (Object.keys(s).length === 0) delete m["servers"];
        else m["servers"] = s;
      }
      if (Object.keys(m).length === 0) delete settings["mcp"];
      else settings["mcp"] = m;
    }
    writeJson(path, settings);
  }
}
