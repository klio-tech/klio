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


# ----------------------------------------------------------------
# Tag-suffix tolerance
#
# `npx @klio-tech/klio init` 0.4.1 wrote `ollama/nomic-embed-text:latest`
# into KLIO_EMBEDDING_MODEL because Ollama's `/api/tags` endpoint
# reports installed models with a `:latest` suffix and the npm picker
# round-tripped the full name. The engine's registry keys by bare model
# name (the embed dim is determined by the base architecture, not the
# tag) so the `:latest` form raised ValueError on every entries / recall
# request — HTTP 500 mid-onboarding.
#
# These tests pin the engine-side defense in depth: any caller who
# passes a tagged Ollama name (`ollama/<model>:tag`) gets the same
# registry hit as the bare form. The fix is also belt-and-suspenders
# for anyone hand-editing `~/.klio/.env` against an older registry.
# ----------------------------------------------------------------


def test_resolve_strips_ollama_latest_tag() -> None:
    """The exact production crash from 0.4.1: Ollama-listed name with
    `:latest` arrives at the registry. Must resolve to the same spec
    as the bare name."""
    spec = resolve("ollama/nomic-embed-text:latest")
    assert spec.name == "ollama/nomic-embed-text"
    assert spec.dim == 768
    assert spec.provider == "ollama"


def test_resolve_strips_arbitrary_ollama_tag() -> None:
    """Tag stripping is not `:latest`-specific. Any colon-suffixed
    tag (`:8b`, `:q4_K_M`, `:v1.5`) on a known Ollama embedding model
    must resolve to the registered bare spec, because the embed dim
    is a property of the base model architecture, not the tag."""
    for tag in ("v1.5", "q4_K_M", "8b", "fp16"):
        spec = resolve(f"ollama/mxbai-embed-large:{tag}")
        assert spec.name == "ollama/mxbai-embed-large"
        assert spec.dim == 1024


def test_resolve_unknown_bare_with_tag_still_raises() -> None:
    """The fix MUST NOT mask typos. An unknown bare name with a tag
    should raise ValueError pointing at the bare form so the operator
    sees the real error rather than `unknown ollama/foo:latest`."""
    with pytest.raises(ValueError, match="ollama/totally-bogus"):
        resolve("ollama/totally-bogus:latest")


def test_resolve_no_tag_unchanged() -> None:
    """Stripping is a no-op when there is no tag. Cover the hot path
    (every existing user with a bare name) explicitly so we know the
    new branch doesn't accidentally mangle the common case."""
    spec = resolve("ollama/nomic-embed-text")
    assert spec.name == "ollama/nomic-embed-text"
    assert spec.dim == 768


def test_resolve_openrouter_with_internal_slash_unchanged() -> None:
    """OpenRouter ids carry slashes (`openrouter/<vendor>/<model>`)
    and never carry colons. Tag stripping operates on the LAST path
    segment only, so an openrouter id is untouched."""
    spec = resolve("openrouter/openai/text-embedding-3-small")
    assert spec.name == "openrouter/openai/text-embedding-3-small"
    assert spec.dim == 1536


def test_resolve_or_synthesize_strips_ollama_tag_for_registry_hit() -> None:
    """`resolve_or_synthesize` is the space-creation path. Same fix
    must apply: a tagged Ollama name resolves to the registry spec
    (override_dim ignored, because the registry remains authoritative
    for canonical models)."""
    from klio_engine.services.embedding_models import resolve_or_synthesize

    spec = resolve_or_synthesize(
        "ollama/nomic-embed-text:latest", override_dim=999
    )
    # Registry wins — override is ignored when the bare form is known.
    assert spec.name == "ollama/nomic-embed-text"
    assert spec.dim == 768
