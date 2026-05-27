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
import unittest.mock

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
    at first-seen and a "stale projects" view would be unusable.

    Note on DB clock: ensure() sets last_seen_at to func.now() which
    on PostgreSQL returns transaction_timestamp() — constant within a
    single transaction. In production each bridge call to ensure() is
    its own request transaction, so successive observations get
    different timestamps. The test must commit between observations
    to simulate that: otherwise both timestamps come from the same
    transaction_timestamp() and tie. We commit, sleep, then call
    ensure() again — mirroring two distinct bridge requests.
    """
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
    # Commit so the next ensure() runs in a fresh transaction with a
    # distinct transaction_timestamp(). Without this, both ensure
    # calls share one tx and func.now() returns the same value.
    await session.commit()

    # Sleep enough that Postgres' clock advances visibly between the
    # two transactions.
    await asyncio.sleep(0.05)

    p2 = await svc.ensure(
        session,
        user_id=u.id,
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/path",
        display_name="klio-tech/klio",
    )
    # last_seen_at is set to a SQL expression (func.now()) by ensure(),
    # not a Python datetime. Flush emits the UPDATE; refresh re-reads
    # the materialized timestamp from the DB before we compare.
    await session.flush()
    await session.refresh(p2)
    assert p2.id == p1.id
    assert p2.last_seen_at > first_seen, (
        f"last_seen_at must bump on re-observation; "
        f"first={first_seen}, second={p2.last_seen_at}"
    )


@pytest.mark.asyncio
async def test_ensure_raises_when_both_keys_missing(session: AsyncSession) -> None:
    """ensure() must be called with at least one of git_remote or
    repo_root_path — the bridge cannot tag an entry against nothing.
    Guards against a silent regression where the validation is
    accidentally removed or weakened.
    """
    u = await _make_user(session)
    svc = ProjectService()
    with pytest.raises(ValueError):
        await svc.ensure(
            session,
            user_id=u.id,
            git_remote=None,
            repo_root_path=None,
            display_name="should-not-be-reached",
        )


@pytest.mark.asyncio
async def test_ensure_savepoint_preserves_caller_transaction(
    session: AsyncSession,
) -> None:
    """The Blocker fix: if ensure() triggers the IntegrityError race
    branch (SAVEPOINT rollback path), the caller's already-pending
    changes in the outer transaction MUST survive.

    Why this matters: the bridge writes an Entry row and then calls
    ensure() to tag it with a project_id. If ensure()'s IntegrityError
    handling rolls back the outer transaction (the pre-fix bug), that
    pending Entry write evaporates silently.

    Mechanism: pre-seed the colliding row via a normal ensure(), then
    add an unrelated pending User to the session WITHOUT flushing —
    this is the caller's "pending work." Force the SECOND ensure to
    hit the INSERT-then-IntegrityError path by monkeypatching _find to
    return None on its FIRST call (simulating the race: "our SELECT
    happened a microsecond before the concurrent writer's INSERT
    committed"). After the IntegrityError, ensure()'s re-find runs
    against the (unpatched) DB and returns the seeded row. The
    SAVEPOINT confines the rollback to ensure()'s own failed INSERT.
    The pending User must still be alive in the outer transaction.
    """
    u = await _make_user(session)
    svc = ProjectService()

    # Seed the row that will cause the partial-unique IntegrityError.
    seeded = await svc.ensure(
        session,
        user_id=u.id,
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/path/a",
        display_name="klio-tech/klio",
    )
    await session.flush()
    seeded_id = seeded.id

    # Add an unrelated pending object to the outer transaction.
    # Do NOT flush — leave it pending in the unit-of-work so we can
    # verify it survives ensure()'s IntegrityError handling.
    pending_user = User()
    session.add(pending_user)

    # Force the second ensure to hit the INSERT path by patching _find
    # to return None on the first call (simulating the race timing).
    # Subsequent _find calls (the post-IntegrityError re-find) run the
    # real query and see the seeded row.
    real_find = svc._find
    call_count = {"n": 0}

    async def patched_find(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return None  # simulate race: our SELECT missed
        return await real_find(*args, **kwargs)  # re-find sees the row

    with unittest.mock.patch.object(svc, "_find", patched_find):
        result = await svc.ensure(
            session,
            user_id=u.id,
            git_remote="git@github.com:klio-tech/klio.git",
            repo_root_path="/path/a",
            display_name="klio-tech/klio",
        )

    assert result.id == seeded_id, "race branch must return the existing row"
    assert call_count["n"] >= 2, (
        "patched _find must have been called at least twice "
        "(initial missed lookup + post-IntegrityError re-find)"
    )

    # The blocker assertion: pending_user must STILL be alive in the
    # outer transaction. If the pre-fix bug (full session.rollback())
    # were present, the pending User would have been evicted and the
    # flush below would not produce an id.
    await session.flush()
    await session.refresh(pending_user)
    assert pending_user.id is not None, (
        "ensure()'s race branch rolled back the caller's outer "
        "transaction (SAVEPOINT not in use)"
    )
