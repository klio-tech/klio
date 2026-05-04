// Ollama daemon detection, model listing, and `ollama pull` driver.
//
// The Ollama daemon serves a JSON API at http://127.0.0.1:11434. We
// detect it via `GET /api/tags` (faster than spawning `ollama list`
// and gives the model list in one call). The response shape we rely
// on is:
//
//   { "models": [ { "name": "nomic-embed-text:latest", "size": 274_000_000 }, … ] }
//
// Anything else on the model object (modified_at, digest, details) is
// ignored. The API doesn't surface embedding dimensionality, so we
// maintain a small static map of known embed-model dims and use it
// both for filtering the picker and (later) when probing.
//
// `pullOllamaModel` shells out to `ollama pull <name>` so we get the
// CLI's progress UI (manifest fetch, layer download bars) for free,
// streaming each stderr line back to the caller via `onProgress`. The
// spawner is dependency-injected so tests don't fork real processes.
//
// This module is fetch-based and dependency-free. Tests override
// `globalThis.fetch` exactly like the OpenRouter test suite does, and
// inject a fake spawner for the pull driver.

import { spawn as defaultSpawn } from "node:child_process";

const OLLAMA_BASE = "http://127.0.0.1:11434";
const DETECT_TIMEOUT_MS = 2000;

export type OllamaModel = {
  /** Full model name as Ollama reports it, including the tag (e.g. "nomic-embed-text:latest"). */
  name: string;
  /** On-disk size in bytes. Surfaced in the picker so users see what they have. */
  size: number;
};

/**
 * Static map of embedding models we know how to score, keyed by the
 * bare model name (sans tag). Anything not in this map is filtered
 * out by `filterToSupportedEmbed` because we can't predict its dim
 * without a probe and we don't want to introduce a probe step into
 * detection. Custom models are still selectable via the picker's
 * free-form escape hatch (Section E3).
 */
const OLLAMA_EMBED_DIMS: Record<string, number> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "snowflake-arctic-embed2": 1024,
  "bge-m3": 1024,
};

/**
 * Cheap liveness check for the Ollama daemon. Returns true on a 2xx
 * from `/api/tags`. Any error (connection refused, DNS, timeout,
 * non-2xx) returns false — the caller treats both "daemon down" and
 * "daemon broken" the same way.
 *
 * The 2-second timeout keeps `klio init` snappy when Ollama isn't
 * installed; the AbortSignal is honoured by Node's fetch.
 */
export async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Enumerate locally installed models via `/api/tags`. Returns the
 * full list verbatim — we don't filter at this layer because the
 * caller may want both "all models" (for the chat picker) and "only
 * embed-supported" (for the embed picker).
 *
 * Throws on non-2xx so the orchestrator can surface a precise error;
 * `isOllamaRunning` already covers the soft-fail case.
 */
export async function listInstalledModels(): Promise<OllamaModel[]> {
  const res = await fetch(`${OLLAMA_BASE}/api/tags`);
  if (!res.ok) {
    throw new Error(`Ollama /api/tags failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { models?: OllamaModel[] };
  return body.models ?? [];
}

/**
 * Strip the `:tag` suffix from a model name. Ollama tags are
 * arbitrary user-chosen labels (`:latest`, `:l`, `:8b`, `:q4_K_M`,
 * etc.); the bare name is what maps to a model family in our dim
 * table.
 */
function bareModelName(name: string): string {
  const colon = name.indexOf(":");
  return colon >= 0 ? name.slice(0, colon) : name;
}

/**
 * Reduce a list of installed models to those we recognise as
 * embedding-capable. The check is by bare name (sans tag) so any tag
 * of a known family is accepted. Unknown families are dropped — they
 * can still be picked via free-form input in the picker layer if the
 * user knows what they're doing.
 */
export function filterToSupportedEmbed(models: OllamaModel[]): OllamaModel[] {
  return models.filter(
    (m) => OLLAMA_EMBED_DIMS[bareModelName(m.name)] !== undefined,
  );
}

/**
 * Lookup helper for the orchestrator: returns the embed dim for a
 * model name (with or without tag) or undefined if unknown. The
 * `~/.klio/runtime/.env` writer needs this to populate
 * `KLIO_EMBED_DIM` without re-probing.
 */
export function getEmbedDim(name: string): number | undefined {
  return OLLAMA_EMBED_DIMS[bareModelName(name)];
}

/**
 * Minimal subset of the `child_process.spawn` return shape that the
 * pull driver actually consumes. We hand-roll this rather than
 * importing `ChildProcess` because tests inject a deliberately
 * narrow stub — keeping the contract here means a stub that
 * satisfies this type compiles cleanly.
 */
export type SpawnedProcess = {
  stderr: {
    on(event: "data", cb: (chunk: Buffer) => void): void;
  } | null;
  on(event: "exit", cb: (code: number | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
};

/**
 * Spawner injection point. Production wires this to
 * `child_process.spawn`; tests pass a fake that stores callbacks and
 * fires them on demand to drive the state machine deterministically.
 */
export type Spawner = (cmd: string, args: string[]) => SpawnedProcess;

/**
 * Drive `ollama pull <name>` to completion, forwarding every stderr
 * line to `onProgress`. Resolves on exit code 0; rejects with a
 * descriptive error on non-zero exit or spawn failure.
 *
 * Why stderr and not stdout: the Ollama CLI writes its progress UI
 * (manifest fetch + per-layer download bars + final "success" line)
 * to stderr. stdout is intentionally ignored; we close it via
 * `stdio: ["ignore", "ignore", "pipe"]` in the default spawner so a
 * future stdout dump can't deadlock the child on a full pipe buffer.
 *
 * Lines are split on `\n` and trimmed-empty lines are skipped so
 * callers never see a noise-only line. The split is deliberately
 * naive (no carriage-return handling) — the Ollama CLI emits LF-only
 * progress, and overzealous parsing here would just hide useful
 * detail from the renderer.
 */
export async function pullOllamaModel(
  name: string,
  onProgress: (line: string) => void,
  spawner?: Spawner,
): Promise<void> {
  const sp =
    spawner ??
    ((cmd: string, args: string[]) =>
      defaultSpawn(cmd, args, {
        stdio: ["ignore", "ignore", "pipe"],
      }) as unknown as SpawnedProcess);
  return new Promise<void>((resolve, reject) => {
    const child = sp("ollama", ["pull", name]);
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) onProgress(trimmed);
        }
      });
    }
    child.on("error", (err: Error) => reject(err));
    child.on("exit", (code: number | null) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ollama pull ${name} exited ${code}`));
    });
  });
}
