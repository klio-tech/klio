/**
 * Routing-shape helpers for model identifiers as they cross the
 * boundary between the npm CLI's user-facing forms (Ollama-listed
 * names with `:tag`, OpenRouter `<vendor>/<model>` ids, custom
 * `<provider>/<...>` strings) and the prefixed shape the engine's
 * dispatch + registry expect (`KLIO_EMBEDDING_MODEL`,
 * `KLIO_EXTRACTION_MODEL`).
 *
 * The functions here are intentionally pure: no I/O, no global
 * state, no awareness of the orchestration in `commands/init.ts`.
 * They are the kind of code where one bug can cost an entire
 * production cohort their wow-moment, so they're tested standalone
 * in `tests/modelRouting.test.ts`.
 *
 * Rationale for the embedding-vs-chat distinction (see
 * `prefixEmbeddingModel`): an Ollama tag suffix is *meaningful* for
 * chat / extraction (`qwen2.5:7b-instruct` and `qwen2.5:1.5b` are
 * different models with different weights, served from the same
 * Ollama daemon under different tags), but is *noise* for embedding
 * (the embed-dim is determined by the base model architecture, so
 * `nomic-embed-text:latest`, `nomic-embed-text:v1.5`, and bare
 * `nomic-embed-text` all emit 768-dim vectors). The engine's
 * embedding registry keys by bare name; chat dispatch pass-throughs
 * the tag as-is.
 */

/**
 * Provider kinds the engine routes by prefix. Stays in sync with
 * the engine-side dispatch in
 * `engine/src/klio_engine/services/embeddings.py:_resolve_for_dispatch`.
 */
export type ProviderKind = "ollama" | "openrouter" | "custom";

/**
 * Strip an Ollama-style `:tag` suffix from the LAST path segment.
 *
 * Tolerant of both bare (`nomic-embed-text:latest`) and prefixed
 * (`ollama/nomic-embed-text:latest`) inputs — the slash position
 * anchors the segment, so the prefix is preserved.
 *
 * Tag-less inputs are returned unchanged. OpenRouter ids
 * (`openrouter/<vendor>/<model>`) carry slashes but never colons,
 * so this is a no-op for them.
 */
export function bareOllamaModel(name: string): string {
  const slash = name.lastIndexOf("/");
  const segStart = slash + 1; // 0 when there is no slash
  const colon = name.indexOf(":", segStart);
  return colon >= 0 ? name.slice(0, colon) : name;
}

/**
 * Add the `<kind>/` prefix to `name` if it isn't already there.
 * Idempotent for already-prefixed inputs. Forwards `undefined`
 * unchanged so call sites can compose with optional values
 * (`providerEmbedModel(provider)`) without an explicit guard.
 *
 * Does NOT touch any tag suffix — chat / extraction tags are
 * meaningful and must reach the upstream backend intact.
 */
export function prefixModel(
  kind: ProviderKind,
  name: string | undefined,
): string | undefined {
  if (!name) return name;
  return name.startsWith(`${kind}/`) ? name : `${kind}/${name}`;
}

/**
 * Like `prefixModel`, but for the embedding slot specifically:
 * normalizes Ollama-tagged inputs to the bare form before
 * prefixing, so `KLIO_EMBEDDING_MODEL` always carries a value the
 * engine's registry can resolve.
 *
 * Cleaning happens FIRST, then the prefix check, so an input that
 * arrives already-prefixed-and-tagged (e.g. a re-run of `klio init`
 * against an `~/.klio/.env` written by buggy 0.4.1) is recovered
 * rather than preserved.
 *
 * `openrouter` and `custom` kinds are passed through unchanged —
 * OpenRouter ids never carry colons, and custom proxies may
 * legitimately use colons in their id space.
 */
export function prefixEmbeddingModel(
  kind: ProviderKind,
  name: string | undefined,
): string | undefined {
  if (!name) return name;
  const cleaned = kind === "ollama" ? bareOllamaModel(name) : name;
  return cleaned.startsWith(`${kind}/`) ? cleaned : `${kind}/${cleaned}`;
}
