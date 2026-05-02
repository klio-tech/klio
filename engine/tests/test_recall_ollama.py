"""End-to-end semantic recall test against a live Ollama container.

Skips automatically if Ollama is unreachable, so this file is safe to run
in CI environments that don't have it. The point is to catch regressions
where a refactor breaks the per-space shadow-table routing while the
stub-embedding tests still pass (because stubs are hash-based, they hide
real-world routing bugs).

Validates the full critical path:
    provision user
    -> create space pinned to ollama/nomic-embed-text (768-d)
    -> write 3 entries with very different content
    -> run a semantic query that lexically does NOT match any entry
    -> assert the closest entry by meaning ranks top-1
"""
from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator

import boto3
import httpx
import pytest
from moto import mock_aws
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from klio_engine.crypto.kms_client import KMSClient
from klio_engine.models.entry import EntryKind
from klio_engine.services.embeddings import EmbeddingService
from klio_engine.services.entries import EntryService
from klio_engine.services.provisioning import provision_user
from klio_engine.services.recall import RecallService

OLLAMA_URL = os.getenv("KLIO_OLLAMA_API_BASE", "http://127.0.0.1:11434")
OLLAMA_MODEL = "ollama/nomic-embed-text"


def _ollama_reachable() -> bool:
    try:
        r = httpx.get(f"{OLLAMA_URL}/api/tags", timeout=2.0)
        if r.status_code != 200:
            return False
        models = r.json().get("models", [])
        return any(
            (m.get("name") or "").startswith("nomic-embed-text") for m in models
        )
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _ollama_reachable(),
    reason="Ollama with nomic-embed-text not reachable; "
    "run `docker compose up -d ollama && make ollama-pull`",
)


@pytest.fixture
async def db_session(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[AsyncSession]:
    monkeypatch.setenv(
        "KLIO_DATABASE_URL",
        "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio",
    )
    monkeypatch.setenv("KLIO_EMBEDDING_MODEL", OLLAMA_MODEL)
    monkeypatch.setenv("KLIO_JWT_SIGNING_KEY", "test-secret")
    engine = create_async_engine(
        "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio"
    )
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with Session() as s:
        yield s
    await engine.dispose()


@pytest.mark.asyncio
async def test_semantic_recall_via_ollama(db_session: AsyncSession) -> None:
    """A recall query that shares no exact keywords with any entry must
    still return the entry closest in meaning. With the stub backend this
    test is unsatisfiable; with real Ollama embeddings it must pass."""
    with mock_aws():
        kms_low = boto3.client("kms", region_name="us-east-1")
        arn = kms_low.create_key()["KeyMetadata"]["Arn"]
        kms = KMSClient(key_arn=arn, region="us-east-1")

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

        bun_entry = await entry_svc.write(
            db_session,
            user_id=provisioned.user_id,
            space_id=provisioned.default_space_id,
            agent_id=provisioned.agent_id,
            kind=EntryKind.MEMORY,
            content="user prefers Bun runtime for JavaScript projects",
        )
        await entry_svc.write(
            db_session,
            user_id=provisioned.user_id,
            space_id=provisioned.default_space_id,
            agent_id=provisioned.agent_id,
            kind=EntryKind.MEMORY,
            content="favourite cuisine is northern Italian, especially handmade pasta",
        )
        await entry_svc.write(
            db_session,
            user_id=provisioned.user_id,
            space_id=provisioned.default_space_id,
            agent_id=provisioned.agent_id,
            kind=EntryKind.DECISION,
            content="we will deploy infrastructure on Railway, not Fly",
        )
        await db_session.commit()

        results = await recall_svc.recall(
            db_session,
            user_id=provisioned.user_id,
            space_id=provisioned.default_space_id,
            query="which JavaScript runtime do I like",
            limit=3,
        )

        assert results, "expected at least one recall hit"
        top_entry, top_score = results[0]
        assert top_entry.id == bun_entry.id, (
            f"expected the Bun entry to be closest; got {top_entry.id} "
            f"with kind={top_entry.kind} score={top_score:.3f}. "
            f"Full ranking: {[(e.id, s) for e, s in results]}"
        )
        assert top_score > 0.4, (
            f"top score {top_score:.3f} too low — Ollama embedding may "
            f"be misconfigured"
        )
