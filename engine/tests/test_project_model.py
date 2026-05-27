"""ORM round-trip + nullable-FK shape tests for the Project model.

Two responsibilities:
  1. Project model itself: PK assignment + created_at/last_seen_at
     defaults work end-to-end through the ORM (not just the schema —
     the schema is tested in test_alembic_migrations.py).
  2. Entry.project_id: nullable FK accepts NULL (legacy/uncategorized
     entries) and accepts a real project_id (forward-going writes).

We follow the existing test pattern (see test_acl.py): use the
`session: AsyncSession` fixture from conftest, build user/agent/space
inline via a small helper, never invent seed_* fixtures.

Entry rows carry NOT NULL `content_ciphertext`/`content_nonce` columns
(encrypted payload from the curator). The unit-test helper synthesises
opaque bytes for these — the project_id tests aren't exercising the
crypto path, just the FK shape. This matches the existing pattern in
`tests/models/test_models.py::test_entry_with_shadow_embedding_round_trip`.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.agent import Agent, AgentKind
from klio_engine.models.entry import Entry, EntryKind
from klio_engine.models.project import Project
from klio_engine.models.space import Space
from klio_engine.models.user import User


async def _make_user_agent_space(session: AsyncSession):
    u = User()
    session.add(u)
    await session.flush()
    a = Agent(user_id=u.id, kind=AgentKind.CLAUDE_CODE, install_id=uuid.uuid4())
    s = Space(user_id=u.id, name="X", slug="x")
    session.add_all([a, s])
    await session.flush()
    return u, a, s


def _entry_kwargs(
    user_id: uuid.UUID,
    space_id: uuid.UUID,
    agent_id: uuid.UUID,
    *,
    project_id: uuid.UUID | None = None,
) -> dict:
    """Minimum kwargs to satisfy Entry's NOT NULL columns.

    `content_ciphertext` / `content_nonce` are NOT NULL on the schema
    (encrypted payload from the curator); these tests don't exercise
    the crypto path, so opaque sentinel bytes are sufficient.
    """
    return dict(
        user_id=user_id,
        space_id=space_id,
        agent_id=agent_id,
        kind=EntryKind.MEMORY,
        content_ciphertext=b"x" * 32,
        content_nonce=b"\x00" * 12,
        project_id=project_id,
    )


@pytest.mark.asyncio
async def test_project_round_trips_through_orm(session: AsyncSession) -> None:
    """Inserting a Project row populates PK + created_at + last_seen_at
    from the DB defaults. Verifies the ORM model matches the migration."""
    u, _, _ = await _make_user_agent_space(session)
    p = Project(
        user_id=u.id,
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/Users/x/klio",
        display_name="klio-tech/klio",
    )
    session.add(p)
    await session.flush()
    await session.refresh(p)
    assert p.id is not None
    assert p.created_at is not None
    assert p.last_seen_at is not None
    assert p.dedicated_space_id is None  # nullable, defaulted


@pytest.mark.asyncio
async def test_project_repo_root_only(session: AsyncSession) -> None:
    """A project with no git remote (local-only repo) writes via the
    repo_root_path fallback path. Validates the partial-unique-index
    semantics from a write angle — the row must be insertable with
    git_remote = NULL."""
    u, _, _ = await _make_user_agent_space(session)
    p = Project(
        user_id=u.id,
        git_remote=None,
        repo_root_path="/Users/x/local-only",
        display_name="local-only",
    )
    session.add(p)
    await session.flush()
    await session.refresh(p)
    assert p.git_remote is None
    assert p.repo_root_path == "/Users/x/local-only"


@pytest.mark.asyncio
async def test_entry_project_id_nullable(session: AsyncSession) -> None:
    """Entry.project_id is nullable — legacy entries written before
    the bridge auto-detects project context (and entries from
    non-git contexts) remain valid. NULL-tagged entries are the
    "surfaces in every project" safe default."""
    u, a, s = await _make_user_agent_space(session)
    e = Entry(**_entry_kwargs(u.id, s.id, a.id, project_id=None))
    session.add(e)
    await session.flush()
    await session.refresh(e)
    assert e.project_id is None


@pytest.mark.asyncio
async def test_entry_with_project_id(session: AsyncSession) -> None:
    """Forward-going writes from the bridge tag entries with their
    source project. Validates the FK accepts a real project row."""
    u, a, s = await _make_user_agent_space(session)
    p = Project(
        user_id=u.id,
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/Users/x/klio",
        display_name="klio-tech/klio",
    )
    session.add(p)
    await session.flush()
    e = Entry(**_entry_kwargs(u.id, s.id, a.id, project_id=p.id))
    session.add(e)
    await session.flush()
    await session.refresh(e)
    assert e.project_id == p.id
