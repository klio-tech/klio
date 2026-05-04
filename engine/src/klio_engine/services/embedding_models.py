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


def resolve(model_name: str | None) -> EmbeddingModelSpec:
    """Return the spec for `model_name`, or the default if `None`/unknown.

    Unknown models raise ValueError so the caller (write path) fails fast
    instead of silently storing vectors with the wrong dim.
    """
    if model_name is None:
        return default_model()
    spec = _BY_NAME.get(model_name)
    if spec is None:
        raise ValueError(
            f"Unknown embedding model {model_name!r}. "
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
