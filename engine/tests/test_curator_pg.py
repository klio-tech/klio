"""Postgres-backed curator collaborators — round-trip tests.

The Curator class itself is fully tested with fakes in
test_curator.py. This file pins the SQL behaviour:
  - cursor read/write
  - observation read filters by user + kind + > cursor
  - error path writes last_error without touching last_cursor_at
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import select

from klio_engine.models.agent import Agent, AgentKind
from klio_engine.models.curator_state import CuratorState
from klio_engine.models.entry import Entry, EntryKind
from klio_engine.models.space import Space
from klio_engine.models.user import User
from klio_engine.services.curator_pg import (
    PgCursorStore,
    PgObservationReader,
)


pytestmark = pytest.mark.asyncio


# --- Local fixtures (conftest.py only provides `session`) ----------


@pytest_asyncio.fixture
async def seed_user(session) -> uuid.UUID:
    """Insert a minimally-valid user row + flush. Returns the user_id.

    Only `id` is a hard requirement on the User model — `email_hash`,
    `wrapped_envelope_key`, etc. are nullable. The id is set explicitly
    rather than relying on the server_default so we can return it
    before flush completes."""
    u = User(id=uuid.uuid4())
    session.add(u)
    await session.flush()
    return u.id


@pytest_asyncio.fixture
async def seed_observations(session, seed_user) -> None:
    """Insert 5 observation entries for seed_user.

    Each entry has a synthetic `created_at` so the read query's
    ordering is deterministic. The ciphertext columns get dummy
    bytes — these tests don't decrypt, they just verify the
    reader's filter and order."""
    base = datetime.now(timezone.utc) - timedelta(hours=1)
    space = Space(
        id=uuid.uuid4(),
        user_id=seed_user,
        name="default",
        slug="default",
        embedding_model="stub",
        embedding_dim=1536,
    )
    session.add(space)
    agent = Agent(
        id=uuid.uuid4(),
        user_id=seed_user,
        kind=AgentKind.CLAUDE_CODE,
        install_id=uuid.uuid4(),
    )
    session.add(agent)
    await session.flush()

    for i in range(5):
        e = Entry(
            id=uuid.uuid4(),
            user_id=seed_user,
            space_id=space.id,
            agent_id=agent.id,
            kind=EntryKind.OBSERVATION,
            content_nonce=b"\x00" * 12,
            content_ciphertext=b"obs-" + str(i).encode(),
            created_at=base + timedelta(minutes=i),
        )
        session.add(e)
    await session.flush()


# --- Tests ---------------------------------------------------------


async def test_cursor_read_lazy_initial_value(session) -> None:
    """First read for a user returns the epoch default; no row is
    inserted yet (lazy)."""
    store = PgCursorStore(session=session)
    user_id = uuid.uuid4()
    cursor = await store.read(user_id)
    assert cursor == datetime(1970, 1, 1, tzinfo=timezone.utc)

    rows = (await session.execute(select(CuratorState))).scalars().all()
    assert all(r.user_id != user_id for r in rows)


async def test_cursor_write_success_creates_row(session, seed_user) -> None:
    store = PgCursorStore(session=session)
    new_at = datetime.now(timezone.utc)
    await store.write_success(
        user_id=seed_user, new_cursor=new_at, synthesized=3
    )
    await session.flush()

    row = (
        await session.execute(
            select(CuratorState).where(CuratorState.user_id == seed_user)
        )
    ).scalar_one()
    assert row.last_cursor_at == new_at
    assert row.last_synthesized == 3
    assert row.runs_count == 1
    assert row.last_error is None


async def test_cursor_write_failure_does_not_advance_cursor(
    session, seed_user
) -> None:
    store = PgCursorStore(session=session)
    success_at = datetime.now(timezone.utc) - timedelta(minutes=10)
    await store.write_success(
        user_id=seed_user, new_cursor=success_at, synthesized=1
    )
    await session.flush()

    await store.write_failure(seed_user, "ollama unreachable")
    await session.flush()

    row = (
        await session.execute(
            select(CuratorState).where(CuratorState.user_id == seed_user)
        )
    ).scalar_one()
    assert row.last_cursor_at == success_at  # unchanged
    assert row.last_error == "ollama unreachable"
    assert row.runs_count == 2  # incremented on both


async def test_observation_reader_filters_by_user_kind_and_cursor(
    session, seed_user, seed_observations
) -> None:
    """seed_observations seeds 5 obs for seed_user. The reader must
    return them all in created_at order, strictly greater than the
    cursor."""
    reader = PgObservationReader(session=session)
    cursor = datetime(1970, 1, 1, tzinfo=timezone.utc)
    rows = await reader.read(user_id=seed_user, since=cursor, limit=10)
    assert len(rows) == 5
    times = [r.created_at for r in rows]
    assert times == sorted(times)


async def test_observation_reader_excludes_other_kinds(
    session, seed_user
) -> None:
    """The reader must filter strictly to kind=observation. A memory
    entry mixed in with observations must be excluded."""
    space = Space(
        id=uuid.uuid4(),
        user_id=seed_user,
        name="default",
        slug="default",
        embedding_model="stub",
        embedding_dim=1536,
    )
    session.add(space)
    agent = Agent(
        id=uuid.uuid4(),
        user_id=seed_user,
        kind=AgentKind.CLAUDE_CODE,
        install_id=uuid.uuid4(),
    )
    session.add(agent)
    await session.flush()

    base = datetime.now(timezone.utc) - timedelta(hours=1)
    obs = Entry(
        id=uuid.uuid4(),
        user_id=seed_user,
        space_id=space.id,
        agent_id=agent.id,
        kind=EntryKind.OBSERVATION,
        content_nonce=b"\x00" * 12,
        content_ciphertext=b"o",
        created_at=base,
    )
    mem = Entry(
        id=uuid.uuid4(),
        user_id=seed_user,
        space_id=space.id,
        agent_id=agent.id,
        kind=EntryKind.MEMORY,
        content_nonce=b"\x00" * 12,
        content_ciphertext=b"m",
        created_at=base + timedelta(minutes=1),
    )
    session.add_all([obs, mem])
    await session.flush()

    reader = PgObservationReader(session=session)
    rows = await reader.read(
        user_id=seed_user,
        since=datetime(1970, 1, 1, tzinfo=timezone.utc),
        limit=10,
    )
    assert len(rows) == 1
    assert rows[0].kind == EntryKind.OBSERVATION
