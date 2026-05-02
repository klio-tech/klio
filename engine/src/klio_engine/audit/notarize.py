"""Notarize audit-log root hashes to a public timestamp authority.

The root hash is a deterministic SHA-256 over the canonical concatenation
of every audit-log row's hash, in (user_id, created_at) order. Two backends:

- 'opentimestamps': submits the root to an OTS calendar server and stores
  the .ots attestation. Requires the optional `opentimestamps` Python lib
  AND network access to a calendar (defaults: alice.btc.calendar.opentimestamps.org).
- 'stub-offline': computes and stores the root locally without external
  submission. Used when the OTS lib is unavailable or KLIO_NOTARIZE_BACKEND=stub.

Anyone can later verify a notarization by:
  1. Independently recomputing the root hash from their copy of the audit
     log (everyone with read access to /v1/audit can do this).
  2. If 'opentimestamps' was used, validating the .ots file against the
     Bitcoin blockchain.
"""
from __future__ import annotations

import hashlib
import os

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.audit import AuditLogEntry
from klio_engine.models.notarization import AuditNotarization


async def compute_global_root(session: AsyncSession) -> tuple[str, int]:
    """Returns (root_hash_hex, audit_log_count) over ALL audit_log rows.

    Deterministic: orders rows by (user_id, created_at, id) then concatenates
    their `hash` columns and SHA-256s the result. Identical state on two
    replicas yields the identical root.
    """
    rows = (
        await session.execute(
            select(AuditLogEntry).order_by(
                AuditLogEntry.user_id,
                AuditLogEntry.created_at,
                AuditLogEntry.id,
            )
        )
    ).scalars().all()
    h = hashlib.sha256()
    for r in rows:
        h.update(r.hash.encode("ascii"))
        h.update(b"\n")
    return h.hexdigest(), len(rows)


def _ots_available() -> bool:
    """Returns True when both the opentimestamps lib is importable AND the
    user has not explicitly disabled it via KLIO_NOTARIZE_BACKEND=stub."""
    if os.getenv("KLIO_NOTARIZE_BACKEND") == "stub":
        return False
    try:  # pragma: no cover - import-existence check
        import opentimestamps  # noqa: F401
        return True
    except ImportError:
        return False


def submit_to_ots(root_hex: str) -> bytes:
    """Submit root_hex to an OpenTimestamps calendar server.

    Returns the .ots attestation file bytes. Raises on failure; callers
    should catch and fall back to stub-offline mode.
    """
    from io import BytesIO

    from opentimestamps.calendar import RemoteCalendar
    from opentimestamps.core.notary import PendingAttestation
    from opentimestamps.core.serialize import StreamSerializationContext
    from opentimestamps.core.timestamp import DetachedTimestampFile, Timestamp

    digest = bytes.fromhex(root_hex)
    timestamp = Timestamp(digest)

    cal_url = os.getenv(
        "KLIO_OTS_CALENDAR_URL",
        "https://alice.btc.calendar.opentimestamps.org",
    )
    cal = RemoteCalendar(cal_url)
    cal.submit(digest)
    timestamp.attestations.add(PendingAttestation(cal_url.encode("utf-8")))

    detached = DetachedTimestampFile.from_fd(timestamp, BytesIO(digest))
    out = BytesIO()
    detached.serialize(StreamSerializationContext(out))
    return out.getvalue()


async def run_notarization(session: AsyncSession) -> AuditNotarization:
    """Compute root, submit to OTS (or stub), persist the AuditNotarization."""
    root_hex, count = await compute_global_root(session)

    backend = "stub-offline"
    ots_bytes: bytes | None = None
    if _ots_available():
        try:
            ots_bytes = submit_to_ots(root_hex)
            backend = "opentimestamps"
        except Exception as e:
            import structlog

            structlog.get_logger().warning(
                "notarize.ots_submit_failed", error=str(e), root=root_hex
            )
            backend = "failed-skipped"

    record = AuditNotarization(
        root_hash=root_hex,
        ots_attestation=ots_bytes,
        backend=backend,
        audit_log_count=count,
    )
    session.add(record)
    await session.commit()
    await session.refresh(record)
    return record
