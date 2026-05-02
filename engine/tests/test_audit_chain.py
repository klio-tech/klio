"""Audit log hash chain tests."""
from datetime import UTC, datetime
from uuid import uuid4

from klio_engine.audit.chain import (
    GENESIS_HASH,
    AuditEvent,
    compute_hash,
    verify_chain,
)


def test_compute_hash_deterministic() -> None:
    e = AuditEvent(
        id=uuid4(), user_id=uuid4(), actor_type="user", actor_id=uuid4(),
        action="space.create", target_type="space", target_id=uuid4(),
        metadata={"name": "Klio"}, prev_hash=GENESIS_HASH,
        created_at=datetime(2026, 5, 2, 12, 0, 0, tzinfo=UTC),
    )
    assert compute_hash(e) == compute_hash(e)
    assert len(compute_hash(e)) == 64


def test_chain_verifies_intact() -> None:
    user_id = uuid4()
    actor_id = uuid4()
    events: list[AuditEvent] = []
    prev = GENESIS_HASH
    for i in range(5):
        e = AuditEvent(
            id=uuid4(), user_id=user_id, actor_type="user", actor_id=actor_id,
            action=f"action.{i}", target_type="x", target_id=uuid4(),
            metadata={"i": i}, prev_hash=prev,
            created_at=datetime(2026, 5, 2, 12, i, 0, tzinfo=UTC),
        )
        e.hash = compute_hash(e)
        events.append(e)
        prev = e.hash
    assert verify_chain(events) is True


def test_chain_detects_tampering() -> None:
    user_id = uuid4()
    e1 = AuditEvent(
        id=uuid4(), user_id=user_id, actor_type="user", actor_id=uuid4(),
        action="a", target_type="x", target_id=uuid4(), metadata={},
        prev_hash=GENESIS_HASH,
        created_at=datetime(2026, 5, 2, 12, 0, 0, tzinfo=UTC),
    )
    e1.hash = compute_hash(e1)
    e2 = AuditEvent(
        id=uuid4(), user_id=user_id, actor_type="user", actor_id=uuid4(),
        action="b", target_type="x", target_id=uuid4(), metadata={},
        prev_hash=e1.hash,
        created_at=datetime(2026, 5, 2, 12, 1, 0, tzinfo=UTC),
    )
    e2.hash = compute_hash(e2)

    # Tamper with e1's metadata after the fact
    e1.metadata = {"tampered": True}
    assert verify_chain([e1, e2]) is False


def test_chain_detects_broken_prev_link() -> None:
    user_id = uuid4()
    e1 = AuditEvent(
        id=uuid4(), user_id=user_id, actor_type="user", actor_id=uuid4(),
        action="a", target_type="x", target_id=uuid4(), metadata={},
        prev_hash=GENESIS_HASH,
        created_at=datetime(2026, 5, 2, 12, 0, 0, tzinfo=UTC),
    )
    e1.hash = compute_hash(e1)
    e2 = AuditEvent(
        id=uuid4(), user_id=user_id, actor_type="user", actor_id=uuid4(),
        action="b", target_type="x", target_id=uuid4(), metadata={},
        prev_hash="x" * 64,  # WRONG: should be e1.hash
        created_at=datetime(2026, 5, 2, 12, 1, 0, tzinfo=UTC),
    )
    e2.hash = compute_hash(e2)
    assert verify_chain([e1, e2]) is False
