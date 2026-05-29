// Persisted cloud credentials for the passive `klio hook` client.
//
// `klio init` (cloud mode) writes the verified API key, the stable
// per-machine agent id, and the brain base URL to ~/.klio/config.json.
// The `klio hook` command (src/commands/hook.ts) reads it on every
// Claude Code lifecycle event to authenticate its capture POSTs — the
// hook has no other way to learn the key, since hooks run as bare
// subprocesses with no init context.
//
// The file holds a SECRET (the API key), so it is written 0600 inside a
// 0700 directory, and re-chmod'd on every write so an existing file's
// perms are corrected too (writeFileSync's mode only applies on create).

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { CLOUD_BASE_URL } from "./cloud.js";

/** Persisted cloud credentials the `klio hook` client needs. */
export type CloudConfig = {
  /** Verified API key — sent as the `X-Vex-Key` header. */
  apiKey: string;
  /** Stable per-machine id — sent as the `X-Vex-Agent` header. */
  agentId: string;
  /** Brain origin (no trailing slash); capture paths hang off this. */
  baseUrl: string;
};

/** Absolute path to the cloud config file (`~/.klio/config.json`). */
export function cloudConfigPath(home: string = homedir()): string {
  return join(home, ".klio", "config.json");
}

/**
 * Read and validate the cloud config. Returns `null` — never throws —
 * when the file is missing, unreadable, malformed, or lacks an API key,
 * so the `klio hook` client can stay silent (exit 0) on an unconfigured
 * machine rather than erroring on every Claude Code event.
 *
 * A missing/blank `baseUrl` falls back to {@link CLOUD_BASE_URL} so an
 * older config written before the field existed still works.
 */
export function readCloudConfig(
  path: string = cloudConfigPath(),
): CloudConfig | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null; // missing / unreadable → not configured
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed → treat as unconfigured
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const o = parsed as Record<string, unknown>;
  const apiKey = typeof o.apiKey === "string" ? o.apiKey : "";
  if (!apiKey) return null; // without a key the hook can't authenticate

  const agentId = typeof o.agentId === "string" ? o.agentId : "";
  const baseUrl =
    typeof o.baseUrl === "string" && o.baseUrl.trim() !== ""
      ? o.baseUrl.replace(/\/+$/, "")
      : CLOUD_BASE_URL;

  return { apiKey, agentId, baseUrl };
}

/**
 * Persist the cloud config, creating `~/.klio` (0700) if needed and
 * writing the file 0600. The trailing slash on `baseUrl` is stripped so
 * the hook client can join capture paths without doubling the slash.
 */
export function writeCloudConfig(
  config: CloudConfig,
  path: string = cloudConfigPath(),
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body =
    JSON.stringify(
      {
        apiKey: config.apiKey,
        agentId: config.agentId,
        baseUrl: config.baseUrl.replace(/\/+$/, ""),
      },
      null,
      2,
    ) + "\n";
  writeFileSync(path, body, { mode: 0o600 });
  // writeFileSync's mode only applies when CREATING the file; force 0600
  // on rewrites too so a re-run never widens the perms of a secret file.
  chmodSync(path, 0o600);
}
