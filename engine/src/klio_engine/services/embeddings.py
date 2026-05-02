"""Embedding service.

Two modes:
  - 'stub' (default in dev/tests): deterministic 1536-dim vector derived
    from sha256(text). Hermetic, fast, no network.
  - 'litellm' (production): calls OpenAI text-embedding-3-small via LiteLLM.

Choose via KLIO_EMBEDDING_MODEL env var ('stub' picks the stub).
"""
import hashlib

from klio_engine.config import Settings


class EmbeddingService:
    def __init__(self, *, model: str | None = None) -> None:
        s = Settings()
        self._model = model or s.embedding_model
        self._cache: dict[str, list[float]] = {}
        self._cache_max = 512

    async def embed(self, text: str) -> list[float]:
        if text in self._cache:
            return self._cache[text]
        if self._model == "stub":
            result = self._stub_embed(text)
        else:
            result = await self._real_embed(text)
        if len(self._cache) >= self._cache_max:
            self._cache.pop(next(iter(self._cache)))
        self._cache[text] = result
        return result

    async def _real_embed(self, text: str) -> list[float]:
        from litellm import aembedding

        response = await aembedding(model=self._model, input=text)
        return response["data"][0]["embedding"]

    @staticmethod
    def _stub_embed(text: str) -> list[float]:
        h = hashlib.sha256(text.encode("utf-8")).digest()
        floats = [(h[i % 32] / 127.5) - 1.0 for i in range(1536)]
        norm = sum(f * f for f in floats) ** 0.5
        return [f / norm for f in floats]
