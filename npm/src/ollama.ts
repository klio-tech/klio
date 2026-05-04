// Ollama daemon detection + model listing.
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
// This module is fetch-based and dependency-free. Tests override
// `globalThis.fetch` exactly like the OpenRouter test suite does.

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
