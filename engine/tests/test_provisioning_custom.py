"""Regression: Phase 3 provision step must succeed for custom/* models.

The 0.3.0 final-review caught that resolve() raised on custom/<...>
because nothing fed the dim to the engine. This test pins the
end-to-end contract: KLIO_EMBEDDING_MODEL=custom/* + KLIO_EMBEDDING_DIM
-> provision succeeds -> default Space has the right dim.
"""
from __future__ import annotations

import importlib
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.crypto.kms_client import KMSClient


@pytest.mark.asyncio
async def test_provision_with_custom_embedding_model(
    monkeypatch: pytest.MonkeyPatch,
    session: AsyncSession,
    mock_kms: KMSClient,
) -> None:
    monkeypatch.setenv("KLIO_DATABASE_URL", "postgresql+asyncpg://x")
    monkeypatch.setenv("KLIO_EMBEDDING_MODEL", "custom/local-embed")
    monkeypatch.setenv("KLIO_EMBEDDING_DIM", "1024")
    monkeypatch.setenv("KLIO_CUSTOM_BASE_URL", "http://localhost:4000/v1")

    # Reload the modules that snapshot env-derived state at import time
    # so this test sees the patched env. config -> embedding_models ->
    # provisioning is the dependency order.
    import klio_engine.config as config_module
    import klio_engine.services.embedding_models as embedding_models
    import klio_engine.services.provisioning as provisioning

    importlib.reload(config_module)
    importlib.reload(embedding_models)
    importlib.reload(provisioning)

    result = await provisioning.provision_user(
        session,
        kms=mock_kms,
        agent_kind="klio-bridge",
        install_id=uuid.uuid4(),
    )

    from klio_engine.models.space import Space

    space = await session.get(Space, result.default_space_id)
    assert space is not None
    assert space.embedding_model == "custom/local-embed"
    assert space.embedding_dim == 1024


@pytest.mark.asyncio
async def test_provision_with_unknown_openrouter_uses_override_dim(
    monkeypatch: pytest.MonkeyPatch,
    session: AsyncSession,
    mock_kms: KMSClient,
) -> None:
    """Escape-hatch path: the user typed an OpenRouter model id we
    don't have in the registry. The npm probe verified the dim, so
    the engine must trust KLIO_EMBEDDING_DIM rather than raising."""
    monkeypatch.setenv("KLIO_DATABASE_URL", "postgresql+asyncpg://x")
    # Deliberately not in EMBEDDING_MODELS — pre-fix this would 500.
    monkeypatch.setenv(
        "KLIO_EMBEDDING_MODEL", "openrouter/openai/text-embedding-3-large"
    )
    monkeypatch.setenv("KLIO_EMBEDDING_DIM", "1536")

    import klio_engine.config as config_module
    import klio_engine.services.embedding_models as embedding_models
    import klio_engine.services.provisioning as provisioning

    importlib.reload(config_module)
    importlib.reload(embedding_models)
    importlib.reload(provisioning)

    result = await provisioning.provision_user(
        session,
        kms=mock_kms,
        agent_kind="klio-bridge",
        install_id=uuid.uuid4(),
    )

    from klio_engine.models.space import Space

    space = await session.get(Space, result.default_space_id)
    assert space is not None
    assert space.embedding_model == "openrouter/openai/text-embedding-3-large"
    assert space.embedding_dim == 1536
