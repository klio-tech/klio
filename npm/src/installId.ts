// Manage a stable per-machine install identifier.
//
// The engine's /v1/users/provision endpoint accepts an install_id;
// passing the same value across re-runs returns the same user_id
// rather than minting a new one. That's what makes `npx klio init`
// idempotent — running it twice doesn't accidentally duplicate
// your account.
//
// We persist the ID to ~/.klio/runtime/install.json (mode 0600).
// First run generates a UUIDv4 via crypto.randomUUID().

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import { runtimeDir, ensureDir } from "./compose.js";

type InstallState = {
  install_id: string;
};

export function getOrCreateInstallId(): string {
  const path = join(runtimeDir(), "install.json");
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as InstallState;
      if (typeof parsed.install_id === "string" && parsed.install_id.length > 0) {
        return parsed.install_id;
      }
    } catch {
      // Corrupt file — overwrite below.
    }
  }
  const id = randomUUID();
  ensureDir(path);
  writeFileSync(path, JSON.stringify({ install_id: id }, null, 2) + "\n", {
    mode: 0o600,
  });
  return id;
}

/**
 * Generate a fresh JWT signing key. Used when ~/.klio/runtime/.env
 * doesn't already have one — we want a different key per install so
 * engine sessions can't be replayed across machines.
 *
 * 32 cryptographically random bytes rendered as hex = 64-char string,
 * sourced from `crypto.randomBytes` (CSPRNG). Stored in the local-dev
 * .env file (mode 0600).
 */
export function generateSigningKey(): string {
  return randomBytes(32).toString("hex");
}
