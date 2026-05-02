"""Append-only audit log writer.

Maintains the SHA-256 hash chain authoritatively in the engine. Callers
provide event content; the writer reads the per-user tail hash, builds
the AuditEvent, computes its hash, and persists it.
"""
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.audit.chain import GENESIS_HASH, AuditEvent, compute_hash
from klio_engine.models.audit import AuditLogEntry


async def write_audit_event(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    actor_type: str,
    actor_id: uuid.UUID | None,
    action: str,
    target_type: str,
    target_id: uuid.UUID | None,
    metadata: dict[str, Any] | None = None,
) -> AuditLogEntry:
    """Write one entry. Returns the persisted ORM row."""
    metadata = metadata or {}

    # Find tail hash for this user
    last = (
        await session.execute(
            select(AuditLogEntry)
            .where(AuditLogEntry.user_id == user_id)
            .order_by(AuditLogEntry.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    prev_hash = last.hash if last else GENESIS_HASH

    new_id = uuid.uuid4()
    now = datetime.now(UTC)
    event = AuditEvent(
        id=new_id,
        user_id=user_id,
        actor_type=actor_type,
        actor_id=actor_id,
        action=action,
        target_type=target_type,
        target_id=target_id,
        metadata=metadata,
        prev_hash=prev_hash,
        created_at=now,
    )
    h = compute_hash(event)

    record = AuditLogEntry(
        id=new_id,
        user_id=user_id,
        actor_type=actor_type,
        actor_id=actor_id,
        action=action,
        target_type=target_type,
        target_id=target_id,
        audit_metadata=metadata,
        prev_hash=prev_hash,
        hash=h,
        created_at=now,
    )
    session.add(record)
    await session.flush()
    return record
