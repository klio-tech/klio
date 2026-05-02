"""Reembed end-to-end: write entries with one model, reembed to another,
verify the shadow tables are swapped and recall still works.

Skips if Ollama is unreachable, since the cross-dim path needs a real
embedding backend to produce meaningfully different vectors.
"""
from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator

import boto3
import httpx
import pytest
from moto import mock_aws
from sqlalchemy import select, text as sql_text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from klio_engine.crypto.kms_client import KMSClient
from klio_engine.models.entry_embedding import (
    EntryEmbedding768,
    EntryEmbedding1536,
)
from klio_engine.models.entry import EntryKind
from klio_engine.models.space import Space
from klio_engine.services.embeddings import EmbeddingService
from klio_engine.services.entries import EntryService
from klio_engine.services.provisioning import provision_user
from klio_engine.services.recall import RecallService
from klio_engine.services.reembed import reembed_space


def _ollama_reachable() -> bool:
    base = os.getenv("KLIO_OLLAMA_API_BASE", "http://127.0.0.1:11434")
    try:
        r = httpx.get(f"{base}/api/tags", timeout=2.0)
        if r.status_code != 200:
            return False
        return any(
            (m.get("name") or "").startswith("nomic-embed-text")
            for m in r.json().get("models", [])
        )
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _ollama_reachable(),
    reason="Ollama with nomic-embed-text not reachable",
)


@pytest.fixture
async def db_session(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[AsyncSession]:
    monkeypatch.setenv(
        "KLIO_DATABASE_URL",
        "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio",
    )
    monkeypatch.setenv("KLIO_EMBEDDING_MODEL", "stub")  # default for new spaces
    monkeypatch.setenv("KLIO_JWT_SIGNING_KEY", "test-secret")
    engine = create_async_engine(
        "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio"
    )
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with Session() as s:
        yield s
    await engine.dispose()


@pytest.mark.asyncio
async def test_reembed_changes_dim_and_shadow(db_session: AsyncSession) -> None:
    """A space provisioned with stub (1536-d) reembedded to nomic (768-d):
    rows must move shadows, recall must work afterwards."""
    with mock_aws():
        kms_low = boto3.client("kms", region_name="us-east-1")
        arn = kms_low.create_key()["KeyMetadata"]["Arn"]
        kms = KMSClient(key_arn=arn, region="us-east-1")

        # Provision with stub default (1536-d)
        provisioned = await provision_user(
            db_session,
            kms=kms,
            agent_kind="claude-code",
            install_id=uuid.uuid4(),
        )
        await db_session.commit()

        embed_svc = EmbeddingService()
        entry_svc = EntryService(kms=kms, embeddings=embed_svc)
        recall_svc = RecallService(embeddings=embed_svc)

        for content in (
            "user prefers Bun runtime",
            "infra runs on Railway",
            "favourite cuisine is Italian",
        ):
            await entry_svc.write(
                db_session,
                user_id=provisioned.user_id,
                space_id=provisioned.default_space_id,
                agent_id=provisioned.agent_id,
                kind=EntryKind.MEMORY,
                content=content,
            )
        await db_session.commit()

        before_1536 = (
            await db_session.execute(
                sql_text(
                    "SELECT COUNT(*) FROM entry_embeddings_1536 WHERE entry_id IN "
                    "(SELECT id FROM entries WHERE space_id = :s)"
                ),
                {"s": provisioned.default_space_id},
            )
        ).scalar_one()
        assert before_1536 == 3, f"expected 3 stub embeddings, got {before_1536}"

        result = await reembed_space(
            db_session,
            kms=kms,
            embeddings=embed_svc,
            user_id=provisioned.user_id,
            actor_agent_id=provisioned.agent_id,
            space_id=provisioned.default_space_id,
            to_model="ollama/nomic-embed-text",
        )

        assert result.from_dim == 1536
        assert result.to_dim == 768
        assert result.entries_processed == 3

        space = await db_session.get(Space, provisioned.default_space_id)
        assert space is not None
        assert space.embedding_model == "ollama/nomic-embed-text"
        assert space.embedding_dim == 768

        after_1536 = (
            await db_session.execute(
                sql_text(
                    "SELECT COUNT(*) FROM entry_embeddings_1536 WHERE entry_id IN "
                    "(SELECT id FROM entries WHERE space_id = :s)"
                ),
                {"s": provisioned.default_space_id},
            )
        ).scalar_one()
        after_768 = (
            await db_session.execute(
                sql_text(
                    "SELECT COUNT(*) FROM entry_embeddings_768 WHERE entry_id IN "
                    "(SELECT id FROM entries WHERE space_id = :s)"
                ),
                {"s": provisioned.default_space_id},
            )
        ).scalar_one()
        assert after_1536 == 0, "old shadow rows should have been deleted"
        assert after_768 == 3, "new shadow rows should hold all entries"

        results = await recall_svc.recall(
            db_session,
            user_id=provisioned.user_id,
            space_id=provisioned.default_space_id,
            query="which JavaScript runtime do I like",
            limit=3,
        )
        assert results, "recall must work with the post-reembed model"
        top_entry, _ = results[0]
        decrypted, _ = await entry_svc.decrypt(
            db_session, top_entry, provisioned.user_id
        )
        assert "Bun" in decrypted, (
            f"expected the Bun entry top-1 after reembed, got: {decrypted!r}"
        )
