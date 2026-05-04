"""Routing dispatch tests for the fact extractor.

After dropping LiteLLM (0.3.0), the cloud path routes by model-name
prefix. These tests mock httpx so we don't hit the network — the
assertions are about which URL gets POSTed to and which attribution
headers travel along.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

from klio_engine.services.extractor import FactExtractor


_OK_BODY = (
    '{"entries": [{"kind": "memory", "content": "user prefers vim", '
    '"confidence": 0.95}]}'
)


def _ok_response_factory(captured):
    async def fake_post(self, url, json, headers):
        captured["url"] = url
        captured["json"] = json
        captured["headers"] = headers

        class R:
            def raise_for_status(self): pass
            def json(self):
                return {
                    "choices": [
                        {"message": {"content": _OK_BODY}}
                    ]
                }
        return R()

    return fake_post


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("KLIO_DATABASE_URL", "postgresql+asyncpg://x")
    monkeypatch.setenv("KLIO_OPENROUTER_API_KEY", "sk-or-test")
    monkeypatch.setenv("KLIO_CUSTOM_BASE_URL", "https://proxy.test/v1")
    monkeypatch.setenv("KLIO_CUSTOM_API_KEY", "sk-custom-test")
    return monkeypatch


@pytest.mark.asyncio
async def test_openrouter_prefix_routes_to_openrouter_with_attribution(env):
    extractor = FactExtractor(model="openrouter/anthropic/claude-3-5-haiku")
    captured = {}

    with patch("httpx.AsyncClient.post", new=_ok_response_factory(captured)):
        entries = await extractor.extract("user prefers vim")

    assert captured["url"] == "https://openrouter.ai/api/v1/chat/completions"
    assert captured["json"]["model"] == "anthropic/claude-3-5-haiku"
    assert captured["headers"]["Authorization"] == "Bearer sk-or-test"
    assert captured["headers"]["X-Title"] == "Klio"
    assert captured["headers"]["HTTP-Referer"] == "https://klio.tech"
    assert len(entries) == 1
    assert entries[0].kind == "memory"


@pytest.mark.asyncio
async def test_custom_prefix_routes_to_user_base_url(env):
    extractor = FactExtractor(model="custom/claude-3-5-haiku")
    captured = {}

    with patch("httpx.AsyncClient.post", new=_ok_response_factory(captured)):
        await extractor.extract("user prefers vim")

    assert captured["url"] == "https://proxy.test/v1/chat/completions"
    assert captured["json"]["model"] == "claude-3-5-haiku"
    assert captured["headers"]["Authorization"] == "Bearer sk-custom-test"


@pytest.mark.asyncio
async def test_custom_prefix_omits_auth_when_key_unset(monkeypatch):
    monkeypatch.setenv("KLIO_DATABASE_URL", "postgresql+asyncpg://x")
    monkeypatch.setenv("KLIO_CUSTOM_BASE_URL", "http://localhost:4000/v1")
    monkeypatch.delenv("KLIO_CUSTOM_API_KEY", raising=False)

    extractor = FactExtractor(model="custom/local-llm")
    captured = {}

    with patch("httpx.AsyncClient.post", new=_ok_response_factory(captured)):
        await extractor.extract("user prefers vim")

    assert "Authorization" not in captured["headers"]


@pytest.mark.asyncio
async def test_unknown_prefix_raises_value_error(env):
    extractor = FactExtractor(model="anthropic/claude-3-5-haiku")
    with pytest.raises(ValueError, match="unsupported"):
        await extractor.extract("user prefers vim")
