"""ProjectService.ensure: get-or-create semantics for projects.

The bridge calls `ensure(remote, root_path, display_name)` on every
write that needs project tagging. This service is the single place
that deduplicates: same git_remote → same project; same repo_root_path
when no remote → same project. It also bumps `last_seen_at` on every
observation so a future "active projects" UI can sort by recency.

Tests use the conftest `session: AsyncSession` fixture and the inline
user-creation helper, mirroring `test_acl.py` / `test_project_model.py`.
"""
from __future__ import annotations

import asyncio

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.user import User
from klio_engine.services.projects import ProjectService


async def _make_user(session: AsyncSession) -> User:
    u = User()
    session.add(u)
    await session.flush()
    return u


@pytest.mark.asyncio
async def test_ensure_creates_on_first_observation(session: AsyncSession) -> None:
    """First observation of a (user, git_remote) tuple inserts a new
    project row and returns it populated."""
    u = await _make_user(session)
    svc = ProjectService()
    p = await svc.ensure(
        session,
        user_id=u.id,
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/Users/x/klio",
        display_name="klio-tech/klio",
    )
    await session.flush()
    await session.refresh(p)
    assert p.id is not None
    assert p.user_id == u.id
    assert p.git_remote == "git@github.com:klio-tech/klio.git"
    assert p.display_name == "klio-tech/klio"
    assert p.created_at is not None
    assert p.last_seen_at is not None


@pytest.mark.asyncio
async def test_ensure_dedupes_by_remote(session: AsyncSession) -> None:
    """Same git_remote → same project, even if repo_root_path differs.

    This matters for users who clone the same repo to multiple paths
    on the same machine, or use git worktrees. The canonical identity
    is the remote URL when present."""
    u = await _make_user(session)
    svc = ProjectService()
    p1 = await svc.ensure(
        session,
        user_id=u.id,
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/path/a",
        display_name="klio-tech/klio",
    )
    p2 = await svc.ensure(
        session,
        user_id=u.id,
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/path/b",  # different path, same remote
        display_name="klio-tech/klio",
    )
    assert p1.id == p2.id


@pytest.mark.asyncio
async def test_ensure_dedupes_by_path_when_no_remote(session: AsyncSession) -> None:
    """For non-git folders (no remote, no repo root), dedupe on
    repo_root_path. The partial-unique-index design makes this the
    correct lookup key when git_remote IS NULL."""
    u = await _make_user(session)
    svc = ProjectService()
    p1 = await svc.ensure(
        session,
        user_id=u.id,
        git_remote=None,
        repo_root_path="/Users/x/local-only",
        display_name="local-only",
    )
    p2 = await svc.ensure(
        session,
        user_id=u.id,
        git_remote=None,
        repo_root_path="/Users/x/local-only",
        display_name="local-only",
    )
    assert p1.id == p2.id


@pytest.mark.asyncio
async def test_ensure_updates_last_seen_at(session: AsyncSession) -> None:
    """Every observation bumps last_seen_at — used by future UIs to
    sort projects by recency. Without this, the timestamp would freeze
    at first-seen and a "stale projects" view would be unusable."""
    u = await _make_user(session)
    svc = ProjectService()
    p1 = await svc.ensure(
        session,
        user_id=u.id,
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/path",
        display_name="klio-tech/klio",
    )
    await session.flush()
    await session.refresh(p1)
    first_seen = p1.last_seen_at

    # Sleep enough that Postgres' clock advances visibly.
    await asyncio.sleep(0.05)

    p2 = await svc.ensure(
        session,
        user_id=u.id,
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/path",
        display_name="klio-tech/klio",
    )
    await session.flush()
    await session.refresh(p2)
    assert p2.id == p1.id
    assert p2.last_seen_at > first_seen, (
        f"last_seen_at must bump on re-observation; "
        f"first={first_seen}, second={p2.last_seen_at}"
    )
