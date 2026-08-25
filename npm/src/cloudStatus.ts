// Cloud credential status for `klio status`: is a key configured, which
// config files on this machine carry it, the masked form for display,
// and the last recorded verification outcome.
//
// Read-only and throw-free by design — status must render on any config
// state, including a half-written or hand-mangled one. The full key is
// used ONLY to test file contents; it never appears in the returned
// struct (masked form only).

import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import { maskKey } from "./cloud.js";
import {
  cloudConfigPath,
  readCloudConfig,
  readLastVerification,
  type VerificationRecord,
} from "./cloudConfig.js";

/** What `klio status` shows about the cloud credential state. */
export type CloudStatus = {
  /** True when ~/.klio/config.json holds a usable API key. */
  configured: boolean;
  /** Masked key (last 4 only) for display, or null when unconfigured. */
  keyMasked: string | null;
  /** Absolute paths of the config files that carry the key. */
  keyFiles: string[];
  /** Last recorded /verify outcome, or null when never recorded. */
  lastVerification: VerificationRecord | null;
};

/**
 * Collect the cloud credential status for one home directory.
 *
 * `home` is a parameter (defaulting to the real home) so tests exercise
 * this against a fixture directory and can never read the developer's
 * own configs — see tests/run.mjs for why that rule exists.
 */
export function collectCloudStatus(home: string = homedir()): CloudStatus {
  const configPath = cloudConfigPath(home);
  const config = readCloudConfig(configPath);
  const lastVerification = readLastVerification(configPath);

  if (config === null) {
    return {
      configured: false,
      keyMasked: null,
      keyFiles: [],
      lastVerification,
    };
  }

  return {
    configured: true,
    keyMasked: maskKey(config.apiKey),
    keyFiles: filesCarryingKey(home, config.apiKey),
    lastVerification,
  };
}

/**
 * Every config file the cloud writers (wireCloudAgents.ts) can touch,
 * plus Klio's own config. Kept as one list so status and the writers
 * stay in sight of each other when a new agent is added.
 */
function candidateConfigFiles(home: string): string[] {
  const files = [
    cloudConfigPath(home),
    // Claude Code's `claude mcp add-json --scope user` writes here.
    join(home, ".claude.json"),
    join(home, ".cursor", "mcp.json"),
    // Both Codex locations: $CODEX_HOME (which Codex reads first) and
    // the default ~/.codex — either can be the one init wrote.
    ...codexConfigPaths(home),
    claudeDesktopConfigPath(home),
    join(xdgConfigDir(home), "opencode", "opencode.json"),
    join(home, ".openclaw", "config.json"),
  ];
  // De-dup (CODEX_HOME etc. can collide with a literal path above).
  return [...new Set(files)];
}

/**
 * The subset of candidate files whose contents literally contain the
 * key. A file that exists but holds a DIFFERENT key (e.g. rotated
 * elsewhere) is deliberately excluded — listing it would claim a wiring
 * that no longer authenticates.
 */
function filesCarryingKey(home: string, apiKey: string): string[] {
  const carrying: string[] = [];
  for (const path of candidateConfigFiles(home)) {
    if (!existsSync(path)) continue;
    let body: string;
    try {
      body = readFileSync(path, "utf8");
    } catch {
      continue; // unreadable → cannot carry anything we can confirm
    }
    if (body.includes(apiKey)) carrying.push(path);
  }
  return carrying;
}

/** Codex config paths: $CODEX_HOME first, default ~/.codex always. */
function codexConfigPaths(home: string): string[] {
  const paths = [join(home, ".codex", "config.toml")];
  const codexHome = process.env.CODEX_HOME;
  if (codexHome) paths.push(join(codexHome, "config.toml"));
  return paths;
}

/** XDG config dir, honouring $XDG_CONFIG_HOME like the adapters do. */
function xdgConfigDir(home: string): string {
  return process.env.XDG_CONFIG_HOME ?? join(home, ".config");
}

/**
 * Per-OS Claude Desktop config path. Mirrors the cloud writer
 * (wireCloudAgents.ts) so status looks exactly where init wrote.
 */
function claudeDesktopConfigPath(home: string): string {
  const p = platform();
  if (p === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  }
  if (p === "win32") {
    const appData = process.env.APPDATA;
    const dir = appData ? join(appData, "Claude") : join(home, "AppData", "Roaming", "Claude");
    return join(dir, "claude_desktop_config.json");
  }
  return join(xdgConfigDir(home), "Claude", "claude_desktop_config.json");
}
