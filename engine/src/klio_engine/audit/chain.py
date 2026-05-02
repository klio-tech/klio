"""Tamper-evident audit log via SHA-256 hash chain.

Each event's hash = sha256(prev_hash || canonical_json(event_fields)).
Verifying the chain is O(n): recompute each event's hash and check it matches
the recorded hash, and that it equals the next event's prev_hash.
"""
from __future__ import annotations

import dataclasses
import hashlib
import json
import uuid
from collections.abc import Iterable
from datetime import datetime
from typing import Any


@dataclasses.dataclass
class AuditEvent:
    id: uuid.UUID
    user_id: uuid.UUID
    actor_type: str
    actor_id: uuid.UUID | None
    action: str
    target_type: str
    target_id: uuid.UUID | None
    metadata: dict[str, Any]
    prev_hash: str
    created_at: datetime
    hash: str | None = None


def _canonicalize(e: AuditEvent) -> bytes:
    """Stable JSON for hashing — sorted keys, no whitespace, ISO timestamps."""
    payload = {
        "id": str(e.id),
        "user_id": str(e.user_id),
        "actor_type": e.actor_type,
        "actor_id": str(e.actor_id) if e.actor_id else None,
        "action": e.action,
        "target_type": e.target_type,
        "target_id": str(e.target_id) if e.target_id else None,
        "metadata": e.metadata,
        "prev_hash": e.prev_hash,
        "created_at": e.created_at.isoformat(),
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def compute_hash(e: AuditEvent) -> str:
    return hashlib.sha256(_canonicalize(e)).hexdigest()


def verify_chain(events: Iterable[AuditEvent]) -> bool:
    """Return True iff every event's recorded hash matches its computed hash
    AND prev_hash links the chain together correctly.
    """
    prev = "0" * 64
    for e in events:
        if e.hash is None:
            return False
        if e.prev_hash != prev:
            return False
        if compute_hash(e) != e.hash:
            return False
        prev = e.hash
    return True


GENESIS_HASH = "0" * 64
