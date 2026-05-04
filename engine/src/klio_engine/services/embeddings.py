"""Embedding service.

Backends, picked per-call by `model_name` prefix:
  - 'stub': deterministic 1536-dim vector derived from sha256(text). Used
    by tests and the regex-stub-only "no LLM available" mode. Hermetic,
    fast, no network. Useless for semantic similarity.
  - 'ollama/<model>': calls a local Ollama server via direct httpx.
    Default base URL is `http://127.0.0.1:11434` overridable via
    KLIO_OLLAMA_API_BASE.
  - 'openrouter/<vendor>/<model>': direct httpx POST to
    https://openrouter.ai/api/v1/embeddings with attribution headers.
    Requires KLIO_OPENROUTER_API_KEY.
  - 'custom/<model>': direct httpx POST to KLIO_CUSTOM_BASE_URL/embeddings.
    Used by self-hosted LiteLLM proxies, Azure OpenAI, vLLM endpoints,
    etc. Authorization header is sent only when KLIO_CUSTOM_API_KEY
    is set.

Anything else raises ValueError to fail fast at the write boundary.

Registry-known names (ollama/*, openrouter/* listed in the registry,
stub) get their dim validated against the registry spec. The
'custom/*' branch validates only against SUPPORTED_DIMS — the dim
comes from the wire response since the caller's proxy may serve any
embedding model — so a 999-dim response on a custom backend fails with
the same loud error as a registry-side mismatch instead of silently
corrupting the shadow table.
"""
from __future__ import annotations

import hashlib
import os

import structlog

from klio_engine.config import Settings
from klio_engine.services.embedding_models import (
    SUPPORTED_DIMS,
    EmbeddingModelSpec,
    default_model,
    resolve,
)


_OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings"
_ATTRIBUTION_HEADERS = {
    "HTTP-Referer": "https://klio.tech",
    "X-Title": "Klio",
}

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
        spec = self._resolve_for_dispatch(model)
        key = (spec.name, text)
        if key in self._cache:
            return self._cache[key], spec

        name = spec.name
        if name == "stub":
            vector = self._stub_embed(text)
        elif name.startswith("ollama/"):
            vector = await self._ollama_embed(text, name)
        elif name.startswith("openrouter/"):
            vector = await self._openrouter_embed(text, name)
        elif name.startswith("custom/"):
            vector = await self._custom_embed(text, name)
        else:
            raise ValueError(
                f"unsupported model {name!r}: name must start with "
                f"ollama/, openrouter/, custom/, or be 'stub'"
            )

        self._validate_dim(spec, vector)

        if len(self._cache) >= self._cache_max:
            self._cache.pop(next(iter(self._cache)))
        self._cache[key] = vector
        return vector, spec

    def _resolve_for_dispatch(
        self, model: str | None
    ) -> EmbeddingModelSpec:
        """Resolve `model` to a spec, allowing pass-through for custom/*.

        Registry-known names route through `resolve()` for full dim
        validation. `custom/*` names bypass the registry because the
        user's proxy may expose models we've never heard of — we still
        validate the response dim against SUPPORTED_DIMS in
        `_validate_dim` below.

        Names that don't match any supported prefix raise ValueError
        with `unsupported` in the message — the dispatch decision is
        owned here, not by the registry, so unknown providers (e.g.
        `anthropic/...`) get a clear routing error rather than the
        registry's longer 'add a row' suggestion."""
        if model is None:
            return self._default
        if model == "stub" or model.startswith(
            ("ollama/", "openrouter/")
        ):
            return resolve(model)
        if model.startswith("custom/"):
            return EmbeddingModelSpec(name=model, dim=0, provider="custom")
        raise ValueError(
            f"unsupported model {model!r}: name must start with "
            f"ollama/, openrouter/, custom/, or be 'stub'"
        )

    @staticmethod
    def _validate_dim(spec: EmbeddingModelSpec, vector: list[float]) -> None:
        """Reject responses whose dim disagrees with the registry/SUPPORTED_DIMS.

        For registry entries (dim > 0) we compare against the registered
        native dim. For `custom/*` (dim == 0) we accept any dim that maps
        to a known shadow table; the caller's downstream write would 500
        otherwise."""
        if spec.dim > 0:
            if len(vector) != spec.dim:
                raise EmbeddingDimMismatch(
                    f"backend {spec.name!r} returned dim={len(vector)} "
                    f"but registry expects {spec.dim}"
                )
            return
        if len(vector) not in SUPPORTED_DIMS:
            raise EmbeddingDimMismatch(
                f"backend {spec.name!r} returned dim={len(vector)} "
                f"which is not in SUPPORTED_DIMS={SUPPORTED_DIMS}"
            )

    async def _ollama_embed(self, text: str, name: str) -> list[float]:
        """Call Ollama directly. The native Ollama endpoint is one HTTP
        call and historically more reliable than third-party wrappers
        for timeout configuration."""
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
    async def _openrouter_embed(text: str, name: str) -> list[float]:
        """Call OpenRouter's OpenAI-compatible /embeddings endpoint.

        Strips the `openrouter/` prefix (OpenRouter expects the bare
        `<vendor>/<model>` form) and sends Klio's attribution headers
        so usage shows up correctly on the OpenRouter dashboard."""
        import httpx

        s = Settings()
        api_key = s.openrouter_api_key
        if not api_key:
            raise ValueError(
                "openrouter/* model requested but KLIO_OPENROUTER_API_KEY "
                "is not set. Either set the env var or switch to ollama/* "
                "or custom/* routing."
            )
        model = name.split("/", 1)[1]
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            **_ATTRIBUTION_HEADERS,
        }
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(
                _OPENROUTER_EMBEDDINGS_URL,
                json={"model": model, "input": text},
                headers=headers,
            )
            r.raise_for_status()
            return r.json()["data"][0]["embedding"]

    @staticmethod
    async def _custom_embed(text: str, name: str) -> list[float]:
        """Call a user-supplied OpenAI-compatible /embeddings endpoint.

        Strips the `custom/` prefix so the wire body carries the model
        name the proxy expects. The Authorization header is sent only
        when KLIO_CUSTOM_API_KEY is set — empty key means no header at
        all (some local proxies reject `Authorization: Bearer ` with an
        empty token)."""
        import httpx

        s = Settings()
        base = s.custom_base_url
        if not base:
            raise ValueError(
                "custom/* model requested but KLIO_CUSTOM_BASE_URL is "
                "not set. Set it to the base URL of your OpenAI-compatible "
                "embeddings proxy (e.g. https://litellm.acme.corp/v1)."
            )
        model = name.split("/", 1)[1]
        headers = {
            "Content-Type": "application/json",
            **_ATTRIBUTION_HEADERS,
        }
        if s.custom_api_key:
            headers["Authorization"] = f"Bearer {s.custom_api_key}"
        url = f"{base.rstrip('/')}/embeddings"
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(
                url,
                json={"model": model, "input": text},
                headers=headers,
            )
            r.raise_for_status()
            return r.json()["data"][0]["embedding"]

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
