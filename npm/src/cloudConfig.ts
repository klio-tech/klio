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
// 0700 directory. Every write goes through {@link atomicWriteFileSync}:
// write a sibling temp file (created 0600, so its permissions are never
// briefly wider than the file it replaces) and `rename` it over the
// destination. `rename` is atomic on the same filesystem, so a crash,
// a killed process, or an ENOSPC mid-write can only ever leave the OLD
// content in place or the fully-written NEW content — never a
// truncated file. Writing in place (`open(O_TRUNC)` then `write`, which
// is what `writeFileSync(path, …)` does) does not have that property:
// a crash in the window between truncate and the last byte leaves a
// 0-byte file, which is exactly the failure this file used to have.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
 * Parse the config file into a plain object, or `null` for any problem
 * (missing, unreadable, malformed, or not a JSON object).
 *
 * The whole-file view, as opposed to {@link readCloudConfig}'s
 * credential view. Callers that own OTHER keys in the same file —
 * `proxy/toggles.ts` owns `proxy` — read through this so there is
 * exactly one place that knows the file is JSON.
 */
export function readConfigObject(path: string = cloudConfigPath()): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * Write `data` to `path` atomically: write a sibling temp file (created
 * with `mode`, same directory so the follow-up rename stays on one
 * filesystem — required for POSIX rename atomicity), then rename it
 * over `path`. The destination is NEVER opened for writing directly, so
 * there is no window in which it holds truncated bytes.
 *
 * On any failure the destination is left completely untouched — the
 * temp file's mode is what the destination ends up with, so there is
 * no separate `chmodSync` step (unlike an in-place write, whose mode
 * argument only applies when CREATING the file, an atomic rename always
 * "creates" the destination from the caller's point of view).
 */
function atomicWriteFileSync(path: string, data: string, mode: number): void {
  const tmpPath = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(tmpPath, data, { mode });
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup; the write already failed, and a leftover
      // temp file is cosmetic, not a correctness problem — nothing
      // reads `${path}.tmp-*` as configuration.
    }
    throw err;
  }
}

/**
 * Write the whole config object back, 0600 inside a 0700 directory.
 * Same perm discipline as {@link writeCloudConfig}, for the same
 * reason: the file holds a secret.
 */
export function writeConfigObject(
  body: Record<string, unknown>,
  path: string = cloudConfigPath(),
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, JSON.stringify(body, null, 2) + "\n", 0o600);
}

/**
 * Outcome of the most recent key verification, persisted alongside the
 * credentials (under the non-credential `lastVerification` key, so
 * {@link writeCloudConfig} carries it forward) and surfaced by
 * `klio status`.
 */
export type VerificationRecord = {
  /** ISO-8601 timestamp of when the verification ran. */
  at: string;
  /** True when /verify accepted the key with the `memory` scope. */
  ok: boolean;
  /** Org resolved from the verify response, when the server sent one. */
  orgId?: string;
  /** Human-readable failure reason, present when `ok` is false. */
  detail?: string;
};

/** The config key {@link writeLastVerification} owns. */
const LAST_VERIFICATION_KEY = "lastVerification";

/**
 * Persist the latest verification outcome without disturbing anything
 * else in the file — credentials, proxy toggles, unknown keys all carry
 * forward verbatim. Creates the file (0600 in a 0700 dir) when it does
 * not exist yet, so a refused `klio init --key` still leaves a record
 * for `klio status` to explain.
 */
export function writeLastVerification(
  record: VerificationRecord,
  path: string = cloudConfigPath(),
): void {
  const existing = readConfigObject(path) ?? {};
  const body: Record<string, unknown> = {
    ...existing,
    [LAST_VERIFICATION_KEY]: {
      at: record.at,
      ok: record.ok,
      ...(record.orgId !== undefined ? { orgId: record.orgId } : {}),
      ...(record.detail !== undefined ? { detail: record.detail } : {}),
    },
  };
  writeConfigObject(body, path);
}

/**
 * Read the last recorded verification, or `null` when none was ever
 * recorded or the stored value is malformed. Never throws — status must
 * render on any config state.
 */
export function readLastVerification(
  path: string = cloudConfigPath(),
): VerificationRecord | null {
  const config = readConfigObject(path);
  if (config === null) return null;
  const raw = config[LAST_VERIFICATION_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.at !== "string" || typeof o.ok !== "boolean") return null;
  return {
    at: o.at,
    ok: o.ok,
    ...(typeof o.orgId === "string" ? { orgId: o.orgId } : {}),
    ...(typeof o.detail === "string" ? { detail: o.detail } : {}),
  };
}

/** The credential fields {@link writeCloudConfig} owns. Everything else is somebody else's. */
const CREDENTIAL_KEYS = ["apiKey", "agentId", "baseUrl"] as const;

/**
 * Everything in the config file that is NOT a credential field.
 *
 * `writeCloudConfig` carries these forward. A re-run of `klio init`
 * that dropped them would silently turn a user's conversations back on
 * — the exact consent failure the persisted `proxy` toggles exist to
 * close, reached from a different direction.
 */
function preservedConfigKeys(path: string): Record<string, unknown> {
  const existing = readConfigObject(path);
  if (existing === null) return {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (!(CREDENTIAL_KEYS as readonly string[]).includes(key)) rest[key] = value;
  }
  return rest;
}

/** Domain separation, so this digest can never collide with any other use of the same inputs. */
const FINGERPRINT_DOMAIN = "klio-proxy-config-fingerprint:v1\n";

/**
 * A short, NON-REVERSIBLE identifier for "which config is this".
 *
 * Published on the proxy's own `/__klio/health` so a caller can tell a
 * proxy running the config it just wrote from a SURVIVOR of an earlier
 * `klio init` still holding port 8787 with credentials that have since
 * been rotated or revoked. Without it, `init` → rotate key → `init`
 * reports "✓ Proxy on" while every recall and capture authenticates
 * with the old key, and fail-open turns that into "no injection, ever",
 * silently.
 *
 * The API KEY ITSELF IS NEVER EXPOSED — only this digest, and only over
 * loopback. A digest is enough because the question being answered is
 * "same or different", never "what is it".
 */
export function configFingerprint(config: CloudConfig | null): string {
  if (config === null) return "none";
  return createHash("sha256")
    .update(FINGERPRINT_DOMAIN)
    .update(`${config.apiKey}\n${config.agentId}\n${config.baseUrl}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Persist the cloud config, creating `~/.klio` (0700) if needed and
 * writing the file 0600. The trailing slash on `baseUrl` is stripped so
 * the hook client can join capture paths without doubling the slash.
 *
 * This function owns the three CREDENTIAL fields and nothing else.
 * Anything else already in the file is carried forward verbatim —
 * specifically the `proxy` block (proxy/toggles.ts), which is where a
 * user's "stop sending my conversations to Klio" lives. Overwriting the
 * whole file here would mean a second `klio init` silently re-enabled
 * capture, which is the same consent bug the persisted toggle exists to
 * close, just reached from a different direction.
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
        ...preservedConfigKeys(path),
      },
      null,
      2,
    ) + "\n";
  atomicWriteFileSync(path, body, 0o600);
}
