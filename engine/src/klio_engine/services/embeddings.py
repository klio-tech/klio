"""Embedding service.

Backends, picked per-call by `model_name`:
  - 'stub': deterministic 1536-dim vector derived from sha256(text). Used
    by tests and the regex-stub-only "no LLM available" mode. Hermetic,
    fast, no network. Useless for semantic similarity.
  - 'ollama/<model>': calls a local Ollama server via LiteLLM. Default
    base URL is `http://127.0.0.1:11434` overridable via KLIO_OLLAMA_API_BASE.
  - anything else: handed to LiteLLM unchanged. Works for OpenAI,
    Anthropic, Cohere, Voyage, etc., as long as the relevant API key is
    set in the environment.

Each call validates the returned vector's length against the model's
expected dim from the registry, so a misconfigured backend (e.g. an
Ollama model rename returning a different dim) fails loudly instead of
silently corrupting the shadow table.
"""
from __future__ import annotations

import hashlib
import os

import structlog

from klio_engine.config import Settings
from klio_engine.services.embedding_models import (
    EmbeddingModelSpec,
    default_model,
    resolve,
)

logger = structlog.get_logger(__name__)


class EmbeddingDimMismatch(RuntimeError):
    """Raised when a backend returns a vector whose length disagrees with
    the registered native dim. Indicates a backend bug or a stale
    registry entry, not a user error."""


class EmbeddingService:
    """Stateless embedding client.

    Caches up to `cache_max` text→vector pairs in-process to avoid
    redundant LLM calls within one process. Cache key is (model, text)
    so spaces on different models do not poison each other.
    """

    def __init__(
        self,
        *,
        default_model_name: str | None = None,
        cache_max: int = 512,
    ) -> None:
        s = Settings()
        self._default = resolve(default_model_name or s.embedding_model)
        self._cache: dict[tuple[str, str], list[float]] = {}
        self._cache_max = cache_max

    @property
    def default_spec(self) -> EmbeddingModelSpec:
        return self._default

    async def embed(
        self,
        text: str,
        *,
        model: str | None = None,
    ) -> tuple[list[float], EmbeddingModelSpec]:
        """Embed `text` with the given model (or default).

        Returns `(vector, spec)` so callers can store the model name
        alongside the vector in the shadow table without re-resolving.
        """
        spec = resolve(model) if model is not None else self._default
        key = (spec.name, text)
        if key in self._cache:
            return self._cache[key], spec

        if spec.name == "stub":
            vector = self._stub_embed(text)
        elif spec.name.startswith("ollama/"):
            vector = await self._ollama_embed(text, spec.name)
        else:
            vector = await self._litellm_embed(text, spec.name)

        if len(vector) != spec.dim:
            raise EmbeddingDimMismatch(
                f"backend {spec.name!r} returned dim={len(vector)} "
                f"but registry expects {spec.dim}"
            )

        if len(self._cache) >= self._cache_max:
            self._cache.pop(next(iter(self._cache)))
        self._cache[key] = vector
        return vector, spec

    async def _ollama_embed(self, text: str, name: str) -> list[float]:
        """Call Ollama directly. We bypass LiteLLM here because LiteLLM's
        ollama provider has historically been flaky around timeout
        configuration, and the native Ollama endpoint is one HTTP call.
        """
        import httpx

        s = Settings()
        base = os.getenv("KLIO_OLLAMA_API_BASE", s.ollama_api_base).rstrip("/")
        model = name.split("/", 1)[1]
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(
                f"{base}/api/embeddings",
                json={"model": model, "prompt": text},
            )
            r.raise_for_status()
            return r.json()["embedding"]

    @staticmethod
    async def _litellm_embed(text: str, model: str) -> list[float]:
        from litellm import aembedding

        response = await aembedding(model=model, input=text)
        return response["data"][0]["embedding"]

    @staticmethod
    def _stub_embed(text: str) -> list[float]:
        h = hashlib.sha256(text.encode("utf-8")).digest()
        floats = [(h[i % 32] / 127.5) - 1.0 for i in range(1536)]
        norm = sum(f * f for f in floats) ** 0.5
        return [f / norm for f in floats]


__all__ = [
    "EmbeddingService",
    "EmbeddingDimMismatch",
    "default_model",
    "resolve",
]
