"""Routing dispatch tests for the embedding service.

After dropping LiteLLM (0.3.0), the embedding service routes by
model-name prefix. These tests mock httpx so we don't hit the
network — the assertions are about which URL gets POSTed to.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

from klio_engine.services.embeddings import EmbeddingService


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("KLIO_DATABASE_URL", "postgresql+asyncpg://x")
    monkeypatch.setenv("KLIO_OPENROUTER_API_KEY", "sk-or-test")
    monkeypatch.setenv("KLIO_CUSTOM_BASE_URL", "https://proxy.test/v1")
    monkeypatch.setenv("KLIO_CUSTOM_API_KEY", "sk-custom-test")
    return monkeypatch


@pytest.mark.asyncio
async def test_openrouter_prefix_routes_to_openrouter_with_attribution(env):
    svc = EmbeddingService()
    captured = {}

    async def fake_post(self, url, json, headers):
        captured["url"] = url
        captured["json"] = json
        captured["headers"] = headers

        class R:
            def raise_for_status(self): pass
            def json(self): return {"data": [{"embedding": [0.0] * 1536}]}
        return R()

    with patch("httpx.AsyncClient.post", new=fake_post):
        vec, _ = await svc.embed(
            "hello", model="openrouter/openai/text-embedding-3-small"
        )

    assert captured["url"] == "https://openrouter.ai/api/v1/embeddings"
    assert captured["json"]["model"] == "openai/text-embedding-3-small"
    assert captured["headers"]["Authorization"] == "Bearer sk-or-test"
    assert captured["headers"]["X-Title"] == "Klio"
    assert captured["headers"]["HTTP-Referer"] == "https://klio.tech"
    assert len(vec) == 1536


@pytest.mark.asyncio
async def test_custom_prefix_routes_to_user_base_url(env):
    svc = EmbeddingService()
    captured = {}

    async def fake_post(self, url, json, headers):
        captured["url"] = url
        captured["json"] = json
        captured["headers"] = headers

        class R:
            def raise_for_status(self): pass
            def json(self): return {"data": [{"embedding": [0.0] * 1536}]}
        return R()

    with patch("httpx.AsyncClient.post", new=fake_post):
        await svc.embed("hello", model="custom/text-embedding-3-small")

    assert captured["url"] == "https://proxy.test/v1/embeddings"
    assert captured["json"]["model"] == "text-embedding-3-small"
    assert captured["headers"]["Authorization"] == "Bearer sk-custom-test"


@pytest.mark.asyncio
async def test_custom_prefix_omits_auth_when_key_unset(monkeypatch):
    monkeypatch.setenv("KLIO_DATABASE_URL", "postgresql+asyncpg://x")
    monkeypatch.setenv("KLIO_CUSTOM_BASE_URL", "http://localhost:4000/v1")
    monkeypatch.delenv("KLIO_CUSTOM_API_KEY", raising=False)

    svc = EmbeddingService()
    captured = {}

    async def fake_post(self, url, json, headers):
        captured["headers"] = headers
        class R:
            def raise_for_status(self): pass
            def json(self): return {"data": [{"embedding": [0.0] * 1536}]}
        return R()

    with patch("httpx.AsyncClient.post", new=fake_post):
        await svc.embed("hi", model="custom/local-embed")

    assert "Authorization" not in captured["headers"]


@pytest.mark.asyncio
async def test_unknown_prefix_raises_value_error(env):
    svc = EmbeddingService()
    with pytest.raises(ValueError, match="unsupported"):
        await svc.embed("hello", model="anthropic/claude-3-5-haiku")
