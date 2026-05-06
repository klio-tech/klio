"""Registry of supported embedding models and their native dimensions.

This is the single source of truth for which embedding backends Klio supports
out of the box. Adding a new model requires:

  1. Adding a row here (model name, dim, provider hint).
  2. Ensuring the dim is one of the supported shadow tables
     (currently 768, 1024, 1536). If not, the migration must be extended.
  3. The model must be reachable via the corresponding direct-httpx
     backend in `embeddings.py` (Ollama for `ollama/*`, OpenRouter for
     `openrouter/*`) at the time `embed()` is called.

`stub` is the deterministic-fake backend used by tests; it always emits
1536-dim vectors derived from sha256(text).

`custom/*` model names are intentionally NOT in this registry — they
route through KLIO_CUSTOM_BASE_URL and the dim is verified against
SUPPORTED_DIMS at call time, since the user's proxy may expose models
we have no static knowledge of.
"""
from __future__ import annotations

from dataclasses import dataclass


SUPPORTED_DIMS: tuple[int, ...] = (768, 1024, 1536)


@dataclass(frozen=True)
class EmbeddingModelSpec:
    """A known embedding model and its native output dimension.

    Attributes:
      name:     Model identifier with backend prefix (e.g.
                'ollama/nomic-embed-text',
                'openrouter/openai/text-embedding-3-small', 'stub').
      dim:      Native output dimension. Must match `SUPPORTED_DIMS`.
      provider: Free-form tag for telemetry / docs.
    """

    name: str
    dim: int
    provider: str


# Order is significant: first entry is the default if the user has not set
# KLIO_EMBEDDING_MODEL. The default is nomic-embed-text because it runs on
# any laptop with no API key and produces solid-quality 768-dim vectors.
#
# Naming convention notes:
#   - `ollama/<model>`              — direct httpx to a local Ollama daemon.
#   - `openrouter/<vendor>/<model>` — direct httpx to OpenRouter (needs
#                                     KLIO_OPENROUTER_API_KEY). Default
#                                     path for the npm-launched onboarding
#                                     flow (`npx @klio-tech/klio init`),
#                                     which writes the prefix when
#                                     threading the user's chosen model
#                                     into compose env. When adding new
#                                     OpenRouter-routed entries, the dim
#                                     must match the model's native output
#                                     size (look it up via OpenRouter's
#                                     /api/v1/models or the upstream docs).
#   - `stub`                        — deterministic 1536-dim fake.
#
# Bare-OpenAI rows (`text-embedding-3-small`, `text-embedding-ada-002`)
# were removed in 0.3.0 alongside the LiteLLM drop; the only OpenAI path
# is via OpenRouter. Anyone with KLIO_EMBEDDING_MODEL set to a bare name
# must migrate to the `openrouter/openai/<model>` form.
EMBEDDING_MODELS: tuple[EmbeddingModelSpec, ...] = (
    EmbeddingModelSpec("ollama/nomic-embed-text", 768, "ollama"),
    EmbeddingModelSpec("ollama/mxbai-embed-large", 1024, "ollama"),
    EmbeddingModelSpec("ollama/snowflake-arctic-embed2", 1024, "ollama"),
    EmbeddingModelSpec("ollama/bge-m3", 1024, "ollama"),
    EmbeddingModelSpec(
        "openrouter/openai/text-embedding-3-small", 1536, "openrouter"
    ),
    EmbeddingModelSpec(
        "openrouter/voyage/voyage-3", 1024, "openrouter"
    ),
    EmbeddingModelSpec(
        "openrouter/cohere/embed-multilingual-v3.0", 1024, "openrouter"
    ),
    EmbeddingModelSpec("stub", 1536, "internal"),
)


_BY_NAME: dict[str, EmbeddingModelSpec] = {m.name: m for m in EMBEDDING_MODELS}


def default_model() -> EmbeddingModelSpec:
    return EMBEDDING_MODELS[0]


def _normalize_for_lookup(model_name: str) -> str:
    """Strip a `:tag` suffix from the last path segment of `model_name`.

    Why: Ollama's `/api/tags` endpoint reports installed models with a
    `:tag` suffix (`nomic-embed-text:latest`, `mxbai-embed-large:v1.5`,
    `nomic-embed-text:8b-q4_K_M`). The npm onboarding flow round-trips
    that full name, so `KLIO_EMBEDDING_MODEL` arrives at the engine as
    `ollama/nomic-embed-text:latest`. The registry keys by bare model
    name because the embed dim is determined by the base model
    architecture, not the tag — `nomic-embed-text:latest`,
    `nomic-embed-text:v1.5`, and bare `nomic-embed-text` all emit
    768-dim vectors.

    Without this normalization the registry lookup misses, `resolve`
    raises ValueError, and every entries / recall request 500s
    mid-onboarding (the production bug fixed in 0.4.2).

    Stripping operates on the LAST path segment so OpenRouter ids
    like `openrouter/openai/text-embedding-3-small` (which carry
    slashes but never colons) are untouched. Bare names without a
    slash (e.g. `stub`) are also handled correctly.

    The function is internal — callers go through `resolve()` /
    `resolve_or_synthesize()` which apply it consistently.
    """
    slash = model_name.rfind("/")
    seg_start = slash + 1  # 0 when no slash present
    colon = model_name.find(":", seg_start)
    if colon < 0:
        return model_name
    return model_name[:colon]


def resolve(model_name: str | None) -> EmbeddingModelSpec:
    """Return the spec for `model_name`, or the default if `None`/unknown.

    Tag-tolerant: an Ollama-style `:tag` suffix on the last path
    segment is stripped before lookup so callers can pass either the
    bare form (`ollama/nomic-embed-text`) or the `/api/tags`-reported
    form (`ollama/nomic-embed-text:latest`) and reach the same spec.

    Unknown bare models raise ValueError so the caller (write path)
    fails fast instead of silently storing vectors with the wrong dim.
    The error message references the bare form so a typo'd name
    surfaces clearly even when the input had a tag attached.
    """
    if model_name is None:
        return default_model()
    normalized = _normalize_for_lookup(model_name)
    spec = _BY_NAME.get(normalized)
    if spec is None:
        raise ValueError(
            f"Unknown embedding model {normalized!r}. "
            f"Add a row to EMBEDDING_MODELS or use one of: "
            f"{', '.join(m.name for m in EMBEDDING_MODELS)}"
        )
    return spec


def shadow_table_for(dim: int) -> str:
    """Map a dim to its shadow table name; raises if unsupported."""
    if dim not in SUPPORTED_DIMS:
        raise ValueError(
            f"Embedding dim {dim} is not one of {SUPPORTED_DIMS}. "
            f"Add a new shadow table migration to support it."
        )
    return f"entry_embeddings_{dim}"


def resolve_or_synthesize(
    model_name: str | None, override_dim: int | None
) -> EmbeddingModelSpec:
    """Resolve `model_name` from the registry, or synthesize a spec.

    Why synthesis exists:
      - `custom/<...>` model names are intentionally NOT in the registry
        because the user's own proxy / runtime can expose any model.
        These names route through KLIO_CUSTOM_BASE_URL at call time and
        the engine has no static way to know the model's native dim.
      - `openrouter/<...>` names the engine doesn't have a row for are
        escape-hatch picks the user typed at the npm picker. The npm-
        side probe verified the dim end-to-end against OpenRouter
        before reaching the engine, so the dim arg is trustworthy.

    Resolution policy:
      - Registry hit -> return the registry spec. `override_dim` is
        ignored so a typo'd KLIO_EMBEDDING_DIM can't silently corrupt
        the dim-pin for a canonical model.
      - Registry miss + `override_dim` set -> synthesize a spec with
        provider="custom" and the supplied dim.
      - Registry miss + no override -> raise ValueError. Failing
        loudly is required: a default Space pinned with the wrong dim
        would corrupt every subsequent embedding write.

    The synthetic spec deliberately mirrors the dispatch-layer
    pass-through used in `services/embeddings.py:_resolve_for_dispatch`
    — the entries-write path uses `spec.dim == 0` as a sentinel for
    "skip re-validation here, let `_validate_dim` enforce it against
    SUPPORTED_DIMS at the per-call boundary." That sentinel is NOT
    used here: `resolve_or_synthesize` is only called by the
    space-creation path, which needs a real dim to pin.
    """
    # Tag-tolerant lookup: see _normalize_for_lookup for the rationale.
    # The space-creation path takes the same Ollama-suffixed input
    # shape as the request-time path, so the same normalization belongs
    # here.
    normalized = (
        _normalize_for_lookup(model_name) if model_name is not None else None
    )
    spec = _BY_NAME.get(normalized) if normalized is not None else None
    if spec is not None:
        return spec
    if override_dim is None:
        names = ", ".join(m.name for m in EMBEDDING_MODELS)
        # Surface the normalized form in the error so a typo'd bare
        # name is obvious even when the caller passed a tagged name.
        shown = normalized if normalized is not None else model_name
        raise ValueError(
            f"Unknown embedding model {shown!r}. "
            f"Add a row to EMBEDDING_MODELS, set KLIO_EMBEDDING_DIM "
            f"to the model's native dim, or use one of: {names}"
        )
    # Custom / unknown-openrouter path: preserve the input verbatim
    # (tag and all) — the dispatch layer in services/embeddings.py
    # forwards this string to the upstream backend, which may
    # legitimately use the tag (Ollama-flavoured custom proxies).
    return EmbeddingModelSpec(
        name=model_name or "",
        dim=override_dim,
        provider="custom",
    )
