"""AuditNotarization — record of a global audit-log root hash submitted
to a public timestamp authority (OpenTimestamps) for tamper-evidence.
"""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Integer, LargeBinary, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from klio_engine.models.base import Base


class AuditNotarization(Base):
    __tablename__ = "audit_notarizations"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    # Hex-encoded SHA-256 root hash over all audit-log entries at the time
    # this notarization was submitted.
    root_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    # The OpenTimestamps attestation file (.ots) bytes. Nullable because in
    # offline / dev mode we record the root without external submission.
    ots_attestation: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)

    # Provenance of the submission: 'opentimestamps' (real), 'stub-offline'
    # (no external call), 'failed-skipped' (attempted, failed gracefully).
    backend: Mapped[str] = mapped_column(String(40), nullable=False)

    # Number of audit_log rows hashed into root_hash at submission time.
    audit_log_count: Mapped[int] = mapped_column(Integer, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
