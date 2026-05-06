"""CuratorWriter — pin synthesised entries to default space + klio-curator agent.

The Curator service (services/curator.py) speaks via a flat-kwargs
EntryWriter Protocol. CuratorWriter is the seam where that flat call
gets resolved into the user's per-user identities (default space,
deterministic curator agent) and forwarded through EntryService.write —
the same encrypted-write + dedup path a user-driven write takes.

These tests pin three things that downstream `recall` and the trust-app
timeline depend on:
  - synthesised entries land in the user's default space (slug="default")
  - they're attributed to a stable `display_name="klio-curator"` agent
    so they're visually distinct from user / Claude / Cursor agents
  - the agent is created lazily on first write, then reused

The fifth test pins the defensive failure mode: if a user has no default
space at the moment the curator ticks, the writer raises rather than
silently creating one (space provisioning is its own ceremony with
embedding-model pinning + audit events; the curator is not authorised
to invent it).
"""
from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select

from klio_engine.crypto.kms_client import KMSClient
from klio_engine.models.agent import Agent
from klio_engine.models.entry import Entry, EntryKind
from klio_engine.models.space import Space
from klio_engine.models.user import User
from klio_engine.services.curator_writer import CuratorWriter
from klio_engine.services.user_keys import UserKeyService


pytestmark = pytest.mark.asyncio


# --- Hermetic env ---------------------------------------------------
#
# CuratorWriter constructs an EntryService, which in turn instantiates
# Settings (pydantic-settings) and EmbeddingService. Without ambient
# env this would fail with `Settings.database_url Field required` and
# would attempt to talk to Ollama for embeddings. The autouse fixture
# below pins the env vars deterministically per-test so the suite runs
# under bare `pytest tests/test_curator_writer.py` with no shell setup
# and `monkeypatch.setenv` auto-restores at teardown.


@pytest.fixture(autouse=True)
def _hermetic_settings_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Auto-applied to every test in this file. The real Settings
    instance constructed by CuratorWriter requires KLIO_DATABASE_URL
    and reads KLIO_EMBEDDING_MODEL for the EmbeddingService inside
    EntryService. Set both to predictable hermetic values so the
    suite runs under bare `pytest` without ambient env."""
    monkeypatch.setenv(
        "KLIO_DATABASE_URL",
        "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio",
    )
    monkeypatch.setenv("KLIO_EMBEDDING_MODEL", "stub")
    monkeypatch.setenv("KLIO_EXTRACTION_MODEL", "stub")


# --- Local fixtures -------------------------------------------------


@pytest_asyncio.fixture
async def seed_user(session, mock_kms: KMSClient) -> uuid.UUID:
    """Insert a user, provision an envelope key, and create the
    default space (slug='default'). Returns the user_id.

    EntryService.write requires `wrapped_envelope_key` to be present,
    so we must run UserKeyService here rather than just inserting a
    bare User row. The default space is seeded with the same
    (slug, embedding_model, embedding_dim) shape provision_user uses
    in production — `embedding_model='stub'` keeps the test hermetic.
    """
    u = User(id=uuid.uuid4())
    session.add(u)
    await session.flush()

    keys = UserKeyService(kms=mock_kms)
    await keys.provision_user_key(session, u)

    space = Space(
        id=uuid.uuid4(),
        user_id=u.id,
        name="Default",
        slug="default",
        embedding_model="stub",
        embedding_dim=1536,
    )
    session.add(space)
    await session.flush()
    return u.id


# --- Tests ---------------------------------------------------------


async def test_writer_creates_curator_agent_lazily(
    session, mock_kms: KMSClient, seed_user
) -> None:
    """First write for a user creates the klio-curator agent.
    Second write reuses it — no duplicate agent rows."""
    writer = CuratorWriter(
        session=session, kms=mock_kms, dedup_threshold=0.92
    )

    # No agents seeded; first write must create one.
    pre = (await session.execute(select(Agent).where(Agent.user_id == seed_user))).scalars().all()
    assert pre == []

    await writer.write(
        user_id=seed_user,
        kind="memory",
        content="user prefers Bun runtime for JS projects",
        confidence=0.9,
    )
    await session.flush()

    after_first = (
        await session.execute(select(Agent).where(Agent.user_id == seed_user))
    ).scalars().all()
    assert len(after_first) == 1
    curator_agent_id = after_first[0].id

    await writer.write(
        user_id=seed_user,
        kind="memory",
        content="user deploys infra on Railway, not Fly",
        confidence=0.8,
    )
    await session.flush()

    after_second = (
        await session.execute(select(Agent).where(Agent.user_id == seed_user))
    ).scalars().all()
    assert len(after_second) == 1
    assert after_second[0].id == curator_agent_id


async def test_writer_pins_to_user_default_space(
    session, mock_kms: KMSClient, seed_user
) -> None:
    """Synthesised entries must land in the user's space whose
    slug is 'default' — never some other space."""
    other = Space(
        id=uuid.uuid4(),
        user_id=seed_user,
        name="Work",
        slug="work",
        embedding_model="stub",
        embedding_dim=1536,
    )
    session.add(other)
    await session.flush()

    default_space_id = (
        await session.execute(
            select(Space.id)
            .where(Space.user_id == seed_user)
            .where(Space.slug == "default")
        )
    ).scalar_one()

    writer = CuratorWriter(
        session=session, kms=mock_kms, dedup_threshold=0.92
    )
    await writer.write(
        user_id=seed_user,
        kind="memory",
        content="curator-synthesised fact",
        confidence=0.7,
    )
    await session.flush()

    rows = (
        await session.execute(select(Entry).where(Entry.user_id == seed_user))
    ).scalars().all()
    assert len(rows) == 1
    assert rows[0].space_id == default_space_id
    assert rows[0].space_id != other.id


async def test_writer_persists_kind_content_metadata(
    session, mock_kms: KMSClient, seed_user
) -> None:
    """kind, confidence, and metadata must round-trip through
    EntryService.write — content is encrypted on disk so we
    decrypt via the same EntryService to verify."""
    from klio_engine.services.embeddings import EmbeddingService
    from klio_engine.services.entries import EntryService

    writer = CuratorWriter(
        session=session, kms=mock_kms, dedup_threshold=0.92
    )
    await writer.write(
        user_id=seed_user,
        kind="decision",
        content="we will deploy on Railway",
        confidence=0.85,
        metadata={"sources": ["obs-1", "obs-2"]},
    )
    await session.flush()

    entry = (
        await session.execute(select(Entry).where(Entry.user_id == seed_user))
    ).scalar_one()
    assert entry.kind == EntryKind.DECISION
    assert entry.confidence == pytest.approx(0.85)

    # Decrypt via EntryService to confirm content + metadata round-trip.
    svc = EntryService(kms=mock_kms, embeddings=EmbeddingService())
    content, metadata = await svc.decrypt(session, entry, seed_user)
    assert content == "we will deploy on Railway"
    assert metadata == {"sources": ["obs-1", "obs-2"]}


async def test_writer_uses_klio_curator_display_name(
    session, mock_kms: KMSClient, seed_user
) -> None:
    """The auto-created agent must have display_name='klio-curator'
    so `recall` and the trust-app timeline can flag synthesised
    entries distinctly from CLAUDE_CODE / CURSOR / etc."""
    writer = CuratorWriter(
        session=session, kms=mock_kms, dedup_threshold=0.92
    )
    await writer.write(
        user_id=seed_user,
        kind="memory",
        content="x",
        confidence=1.0,
    )
    await session.flush()

    agent = (
        await session.execute(select(Agent).where(Agent.user_id == seed_user))
    ).scalar_one()
    assert agent.display_name == "klio-curator"


async def test_writer_raises_when_user_has_no_default_space(
    session, mock_kms: KMSClient
) -> None:
    """A user with no slug='default' space must produce a clear
    error rather than the writer silently inventing one or writing
    into the wrong space. Space provisioning is its own ceremony."""
    u = User(id=uuid.uuid4())
    session.add(u)
    await session.flush()

    keys = UserKeyService(kms=mock_kms)
    await keys.provision_user_key(session, u)
    # NOTE: deliberately no Space seeded.

    writer = CuratorWriter(
        session=session, kms=mock_kms, dedup_threshold=0.92
    )
    with pytest.raises(RuntimeError, match="default space"):
        await writer.write(
            user_id=u.id,
            kind="memory",
            content="x",
            confidence=1.0,
        )
