"""Smoke test that LiteLLM routes openrouter/* embedding calls correctly.

Skipped by default. To run locally:

    KLIO_TEST_OPENROUTER_KEY=sk-or-... pytest \
        engine/tests/integration/test_openrouter_embedding.py -v

Cost per run: ~$0.000001 against text-embedding-3-small.

If this test fails with "Unsupported model" or similar, the
implementation plan branches to Task 1.3 — adding a thin direct-HTTP
wrapper in engine/src/klio_engine/services/embeddings.py to call
OpenRouter's /embeddings endpoint without going through LiteLLM.
"""
import os

import pytest


@pytest.mark.skipif(
    not os.getenv("KLIO_TEST_OPENROUTER_KEY"),
    reason="set KLIO_TEST_OPENROUTER_KEY to run; ~$0.000001 per run",
)
def test_litellm_routes_openrouter_embedding(monkeypatch):
    """Confirm LiteLLM's openrouter/ prefix works for embeddings.
    If this fails, we need a wrapper; see Task 1.3."""
    monkeypatch.setenv(
        "OPENROUTER_API_KEY", os.environ["KLIO_TEST_OPENROUTER_KEY"]
    )
    import litellm

    resp = litellm.embedding(
        model="openrouter/openai/text-embedding-3-small",
        input="ok",
    )
    assert resp.data[0]["embedding"]
    assert len(resp.data[0]["embedding"]) == 1536
