"""Regression tests for the EMBEDDING_MODELS registry.

The npm onboarding flow at `npx @klio-tech/klio init` writes
`openrouter/<vendor>/<model>` into `KLIO_EMBEDDING_MODEL` so LiteLLM
routes through OpenRouter. The engine's space-creation path resolves
that string against EMBEDDING_MODELS to find the dim, and 400s on
unknown names. A 0.2.0 ship hit HTTP 400 at /v1/users/provision when
these rows were missing — these tests prevent that regression from
landing again.
"""
from __future__ import annotations

import pytest

from klio_engine.services.embedding_models import (
    EMBEDDING_MODELS,
    resolve,
    SUPPORTED_DIMS,
)


def test_registry_includes_openrouter_text_embedding_3_small() -> None:
    spec = resolve("openrouter/openai/text-embedding-3-small")
    assert spec.dim == 1536
    assert spec.provider == "openrouter"


def test_every_registry_dim_is_supported() -> None:
    """Catch a future drift where someone adds a 3072-dim model
    without also adding the matching shadow-table migration."""
    for spec in EMBEDDING_MODELS:
        assert spec.dim in SUPPORTED_DIMS, (
            f"{spec.name} has dim {spec.dim}, "
            f"not in SUPPORTED_DIMS={SUPPORTED_DIMS}"
        )


def test_resolve_unknown_model_raises_value_error() -> None:
    """Defence-in-depth: the engine must surface a clear error for
    typo'd names rather than silently embedding into the wrong dim."""
    with pytest.raises(ValueError, match="Unknown embedding model"):
        resolve("openai/text-embedding-3-small")  # missing openrouter/ prefix


def test_bare_openai_models_removed():
    """0.3.0 drops LiteLLM-routed bare OpenAI rows. Anyone with
    KLIO_EMBEDDING_MODEL=text-embedding-3-small must migrate to
    openrouter/openai/text-embedding-3-small."""
    from klio_engine.services.embedding_models import EMBEDDING_MODELS
    names = {m.name for m in EMBEDDING_MODELS}
    assert "text-embedding-3-small" not in names
    assert "text-embedding-ada-002" not in names


def test_voyage_and_cohere_added():
    from klio_engine.services.embedding_models import EMBEDDING_MODELS
    names = {m.name for m in EMBEDDING_MODELS}
    assert "openrouter/voyage/voyage-3" in names
    assert "openrouter/cohere/embed-multilingual-v3.0" in names


def test_resolve_bare_openai_now_raises():
    import pytest
    from klio_engine.services.embedding_models import resolve
    with pytest.raises(ValueError, match="Unknown embedding model"):
        resolve("text-embedding-3-small")


def test_resolve_or_synthesize_returns_registry_spec_when_known():
    """Registry wins when the name is known — override is ignored.

    This guarantees the registry remains authoritative for canonical
    models so a typo in KLIO_EMBEDDING_DIM can't silently corrupt the
    space-pin for a model the engine already understands."""
    from klio_engine.services.embedding_models import resolve_or_synthesize
    spec = resolve_or_synthesize(
        "openrouter/openai/text-embedding-3-small", override_dim=999
    )
    # Registry wins — override is ignored when name is known.
    assert spec.dim == 1536


def test_resolve_or_synthesize_uses_override_for_custom():
    """custom/<...> models are user-runtime-supplied and intentionally
    not in the registry. The npm probe verified the dim end-to-end, so
    we trust the override here."""
    from klio_engine.services.embedding_models import resolve_or_synthesize
    spec = resolve_or_synthesize("custom/anything", override_dim=1024)
    assert spec.name == "custom/anything"
    assert spec.dim == 1024


def test_resolve_or_synthesize_uses_override_for_unknown_openrouter():
    """User typed a custom model name at the picker — engine doesn't
    have it in registry but the npm probe verified the dim."""
    from klio_engine.services.embedding_models import resolve_or_synthesize
    spec = resolve_or_synthesize(
        "openrouter/openai/text-embedding-3-large", override_dim=3072
    )
    # Note: 3072 is NOT in SUPPORTED_DIMS — that's a separate problem the
    # caller handles. resolve_or_synthesize just trusts the dim arg.
    assert spec.dim == 3072


def test_resolve_or_synthesize_raises_when_unknown_and_no_override():
    """Defence-in-depth — if both registry and override miss, fail loudly."""
    import pytest
    from klio_engine.services.embedding_models import resolve_or_synthesize
    with pytest.raises(ValueError, match="Unknown embedding model"):
        resolve_or_synthesize("custom/anything", override_dim=None)
