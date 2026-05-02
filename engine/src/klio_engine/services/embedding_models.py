"""Registry of supported embedding models and their native dimensions.

This is the single source of truth for which embedding backends Klio supports
out of the box. Adding a new model requires:

  1. Adding a row here (model name, dim, provider hint).
  2. Ensuring the dim is one of the supported shadow tables
     (currently 768, 1024, 1536). If not, the migration must be extended.
  3. The model must be reachable via LiteLLM (Ollama, OpenAI, Anthropic,
     Cohere, etc.) at the time `embed()` is called.

`stub` is the deterministic-fake backend used by tests; it always emits
1536-dim vectors derived from sha256(text).
"""
from __future__ import annotations

from dataclasses import dataclass


SUPPORTED_DIMS: tuple[int, ...] = (768, 1024, 1536)


@dataclass(frozen=True)
class EmbeddingModelSpec:
    """A known embedding model and its native output dimension.

    Attributes:
      name:     Model identifier as accepted by LiteLLM (e.g.
                'ollama/nomic-embed-text', 'text-embedding-3-small').
      dim:      Native output dimension. Must match `SUPPORTED_DIMS`.
      provider: Free-form tag for telemetry / docs.
    """

    name: str
    dim: int
    provider: str


# Order is significant: first entry is the default if the user has not set
# KLIO_EMBEDDING_MODEL. The default is nomic-embed-text because it runs on
# any laptop with no API key and produces solid-quality 768-dim vectors.
EMBEDDING_MODELS: tuple[EmbeddingModelSpec, ...] = (
    EmbeddingModelSpec("ollama/nomic-embed-text", 768, "ollama"),
    EmbeddingModelSpec("ollama/mxbai-embed-large", 1024, "ollama"),
    EmbeddingModelSpec("ollama/snowflake-arctic-embed2", 1024, "ollama"),
    EmbeddingModelSpec("ollama/bge-m3", 1024, "ollama"),
    EmbeddingModelSpec("text-embedding-3-small", 1536, "openai"),
    EmbeddingModelSpec("text-embedding-ada-002", 1536, "openai"),
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
