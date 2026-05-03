// JSON read/write/backup helpers shared between adapters.
// Same semantics as bridge/internal/agentadapters/util.go.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Read a JSON file as an object. Returns {} for empty/missing files.
 * Throws on malformed JSON so a corrupt user config is loud, not
 * silent (we'd rather refuse to overwrite than scribble on top of
 * a partial JSON parse).
 */
export function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (raw === "") return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
      throw new Error("expected JSON object at top level");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `config at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Pretty-print and write JSON. Creates parent dir if missing.
 * Mode 0644 because settings.json files are user-readable by
 * convention; the daemon never holds secrets here (those live in
 * the bridge container's keychain volume).
 */
export function writeJson(path: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o644 });
}

/**
 * Copy `path` to `<path>.klio-backup-<unix-ts>` so a future uninstall
 * can restore it. We append a timestamp instead of overwriting a
 * single backup file because re-running klio init multiple times
 * produces multiple backups; the latest wins on restore. This
 * sacrifices disk space for safety — a user who manually edited their
 * config between two re-installs can still recover the intermediate
 * state.
 */
export function backupFile(path: string): void {
  if (!existsSync(path)) return;
  const backup = `${path}.klio-backup-${Math.floor(Date.now() / 1000)}`;
  copyFileSync(path, backup);
}

/**
 * Restore from the most recent .klio-backup-<ts> file next to `path`.
 * Throws when no backup is found — the caller decides whether to
 * fall back to in-place stripping.
 */
export function restoreFromBackup(path: string): void {
  const dir = dirname(path);
  const base = path.split("/").pop()!;
  const prefix = `${base}.klio-backup-`;

  let latest: string | null = null;
  let latestTs = 0;

  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith(prefix)) continue;
    const ts = Number(entry.slice(prefix.length));
    if (Number.isFinite(ts) && ts > latestTs) {
      latest = entry;
      latestTs = ts;
    }
  }
  if (!latest) {
    throw new Error(`no Klio backup found for ${path}`);
  }
  copyFileSync(join(dir, latest), path);
}
