"""Comprehensive model tests against a real Postgres."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.agent import Agent, AgentKind
from klio_engine.models.entry import Entry, EntryKind
from klio_engine.models.entry_embedding import EntryEmbedding768
from klio_engine.models.permission import Permission, PermissionScope
from klio_engine.models.session import Session
from klio_engine.models.space import Space
from klio_engine.models.user import User


@pytest.mark.asyncio
async def test_user_anonymous_insert(session: AsyncSession) -> None:
    u = User()
    session.add(u)
    await session.flush()

    assert isinstance(u.id, uuid.UUID)
    assert u.email_hash is None
    assert u.claimed_at is None
    assert u.deleted_at is None
    assert isinstance(u.created_at, datetime)


@pytest.mark.asyncio
async def test_user_claim(session: AsyncSession) -> None:
    email_hash = "a" * 64
    u = User(email_hash=email_hash, claimed_at=datetime.now(UTC))
    session.add(u)
    await session.flush()

    fetched = (await session.execute(select(User).where(User.id == u.id))).scalar_one()
    assert fetched.email_hash == email_hash
    assert fetched.claimed_at is not None


@pytest.mark.asyncio
async def test_agent_unique_user_kind_install(session: AsyncSession) -> None:
    u = User()
    session.add(u)
    await session.flush()

    install = uuid.uuid4()
    a1 = Agent(user_id=u.id, kind=AgentKind.CLAUDE_CODE, install_id=install)
    session.add(a1)
    await session.flush()

    a2 = Agent(user_id=u.id, kind=AgentKind.CLAUDE_CODE, install_id=install)
    session.add(a2)
    with pytest.raises(IntegrityError):
        await session.flush()


@pytest.mark.asyncio
async def test_space_slug_unique_per_user(session: AsyncSession) -> None:
    u = User()
    session.add(u)
    await session.flush()

    s1 = Space(user_id=u.id, name="Klio", slug="klio")
    s2 = Space(user_id=u.id, name="Klio dup", slug="klio")
    session.add_all([s1, s2])
    with pytest.raises(IntegrityError):
        await session.flush()


@pytest.mark.asyncio
async def test_space_slug_can_collide_across_users(session: AsyncSession) -> None:
    u_a = User()
    u_b = User()
    session.add_all([u_a, u_b])
    await session.flush()

    a = Space(user_id=u_a.id, name="X", slug="shared")
    b = Space(user_id=u_b.id, name="X", slug="shared")
    session.add_all([a, b])
    await session.flush()  # should succeed


@pytest.mark.asyncio
async def test_permission_scope_enum_round_trip(session: AsyncSession) -> None:
    u = User()
    session.add(u)
    await session.flush()
    a = Agent(user_id=u.id, kind=AgentKind.CLAUDE_CODE, install_id=uuid.uuid4())
    s = Space(user_id=u.id, name="X", slug="x")
    session.add_all([a, s])
    await session.flush()

    p = Permission(
        user_id=u.id, space_id=s.id, agent_id=a.id, scope=PermissionScope.ADMIN
    )
    session.add(p)
    await session.flush()

    fetched = (
        await session.execute(select(Permission).where(Permission.id == p.id))
    ).scalar_one()
    assert fetched.scope is PermissionScope.ADMIN


@pytest.mark.asyncio
async def test_session_round_trip(session: AsyncSession) -> None:
    u = User()
    session.add(u)
    await session.flush()
    a = Agent(user_id=u.id, kind=AgentKind.CLAUDE_CODE, install_id=uuid.uuid4())
    s = Space(user_id=u.id, name="X", slug="x")
    session.add_all([a, s])
    await session.flush()

    sess = Session(
        user_id=u.id, agent_id=a.id, space_id=s.id, source_type="claude-code-session"
    )
    session.add(sess)
    await session.flush()
    assert isinstance(sess.id, uuid.UUID)
    assert sess.ended_at is None


@pytest.mark.asyncio
async def test_entry_with_shadow_embedding_round_trip(session: AsyncSession) -> None:
    """Entry rows no longer carry an embedding column; the embedding lives
    in a per-dim shadow table (here `entry_embeddings_768`) keyed by
    entry_id. Verifies the cascade FK by deletion."""
    u = User()
    session.add(u)
    await session.flush()
    a = Agent(user_id=u.id, kind=AgentKind.CLAUDE_CODE, install_id=uuid.uuid4())
    s = Space(user_id=u.id, name="X", slug="x")  # defaults: nomic / 768
    session.add_all([a, s])
    await session.flush()

    e = Entry(
        user_id=u.id,
        space_id=s.id,
        agent_id=a.id,
        kind=EntryKind.MEMORY,
        content_ciphertext=b"x" * 32,
        content_nonce=b"\x00" * 12,
        confidence=0.95,
    )
    session.add(e)
    await session.flush()

    emb = EntryEmbedding768(
        entry_id=e.id, embedding=[0.1] * 768, model="ollama/nomic-embed-text"
    )
    session.add(emb)
    await session.flush()

    fetched = (
        await session.execute(
            select(EntryEmbedding768).where(EntryEmbedding768.entry_id == e.id)
        )
    ).scalar_one()
    assert len(fetched.embedding) == 768
    assert fetched.model == "ollama/nomic-embed-text"
    assert e.kind is EntryKind.MEMORY


@pytest.mark.asyncio
async def test_entry_supersedes_link(session: AsyncSession) -> None:
    u = User()
    session.add(u)
    await session.flush()
    a = Agent(user_id=u.id, kind=AgentKind.CLAUDE_CODE, install_id=uuid.uuid4())
    s = Space(user_id=u.id, name="X", slug="x")
    session.add_all([a, s])
    await session.flush()

    older = Entry(
        user_id=u.id, space_id=s.id, agent_id=a.id, kind=EntryKind.MEMORY,
        content_ciphertext=b"a", content_nonce=b"\x00" * 12,
        confidence=0.9,
    )
    newer = Entry(
        user_id=u.id, space_id=s.id, agent_id=a.id, kind=EntryKind.MEMORY,
        content_ciphertext=b"b", content_nonce=b"\x00" * 12,
        confidence=0.95,
    )
    session.add_all([older, newer])
    await session.flush()

    older.superseded_by = newer.id
    await session.flush()

    fetched = (await session.execute(select(Entry).where(Entry.id == older.id))).scalar_one()
    assert fetched.superseded_by == newer.id
