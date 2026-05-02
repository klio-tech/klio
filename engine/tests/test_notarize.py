"""Notarization tests."""
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.audit.notarize import compute_global_root, run_notarization
from klio_engine.audit.writer import write_audit_event
from klio_engine.models.notarization import AuditNotarization
from klio_engine.models.user import User


@pytest.mark.asyncio
async def test_compute_global_root_returns_64_hex_chars(
    session: AsyncSession,
) -> None:
    root, count = await compute_global_root(session)
    assert isinstance(root, str)
    assert len(root) == 64
    int(root, 16)  # raises if not hex
    assert count >= 0


@pytest.mark.asyncio
async def test_compute_global_root_deterministic(session: AsyncSession) -> None:
    user_id = uuid.uuid4()
    u = User(id=user_id)
    session.add(u)
    await session.flush()

    for action in ["a", "b", "c"]:
        await write_audit_event(
            session,
            user_id=user_id,
            actor_type="user",
            actor_id=user_id,
            action=action,
            target_type="x",
            target_id=uuid.uuid4(),
            metadata={},
        )
    await session.flush()

    r1, c1 = await compute_global_root(session)
    r2, c2 = await compute_global_root(session)
    assert r1 == r2
    assert c1 == c2


@pytest.mark.asyncio
async def test_compute_global_root_changes_with_state(
    session: AsyncSession,
) -> None:
    user_id = uuid.uuid4()
    u = User(id=user_id)
    session.add(u)
    await session.flush()

    r_before, count_before = await compute_global_root(session)
    await write_audit_event(
        session,
        user_id=user_id,
        actor_type="user",
        actor_id=user_id,
        action="some-new-action",
        target_type="x",
        target_id=uuid.uuid4(),
        metadata={},
    )
    await session.flush()
    r_after, count_after = await compute_global_root(session)
    assert r_before != r_after
    assert count_after == count_before + 1


@pytest.mark.asyncio
async def test_run_notarization_stub_mode_persists_record(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("KLIO_NOTARIZE_BACKEND", "stub")

    record = await run_notarization(session)
    assert record.backend == "stub-offline"
    assert record.ots_attestation is None  # null in stub mode
    assert len(record.root_hash) == 64

    fetched = await session.get(AuditNotarization, record.id)
    assert fetched is not None
    assert fetched.backend == "stub-offline"


@pytest.mark.asyncio
async def test_run_notarization_count_increases_with_writes(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Adding 4 audit-log entries should make audit_log_count grow by exactly 4
    between two consecutive notarization snapshots."""
    monkeypatch.setenv("KLIO_NOTARIZE_BACKEND", "stub")

    snap1 = await run_notarization(session)

    user_id = uuid.uuid4()
    u = User(id=user_id)
    session.add(u)
    await session.flush()

    for action in ["x.1", "x.2", "x.3", "x.4"]:
        await write_audit_event(
            session,
            user_id=user_id,
            actor_type="user",
            actor_id=user_id,
            action=action,
            target_type="x",
            target_id=uuid.uuid4(),
            metadata={},
        )
    await session.flush()

    snap2 = await run_notarization(session)
    assert snap2.audit_log_count == snap1.audit_log_count + 4
    assert snap2.root_hash != snap1.root_hash
