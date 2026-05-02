"""Entry model — the unit of all stored content."""
import enum
import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import DateTime, Enum, Float, ForeignKey, Index, LargeBinary, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from klio_engine.models.base import Base


class EntryKind(str, enum.Enum):
    """Five entry kinds for v0; HANDOFF ships in Phase 1 expansion."""

    MEMORY = "memory"
    OBSERVATION = "observation"
    PLAN = "plan"
    DECISION = "decision"
    NOTE = "note"


class Entry(Base):
    __tablename__ = "entries"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    space_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("spaces.id", ondelete="CASCADE"), nullable=False
    )
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sessions.id", ondelete="SET NULL"),
        nullable=True,
    )
    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[EntryKind] = mapped_column(
        Enum(
            EntryKind,
            name="entry_kind",
            values_callable=lambda obj: [e.value for e in obj],
        ),
        nullable=False,
    )

    # Encrypted payload (per-user envelope key, AES-256-GCM).
    content_ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    content_nonce: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    metadata_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    metadata_nonce: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    encryption_key_id: Mapped[str | None] = mapped_column(String(200), nullable=True)

    # Plaintext, searchable.
    embedding: Mapped[list[float]] = mapped_column(Vector(1536), nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)

    superseded_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("entries.id", ondelete="SET NULL"),
        nullable=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index(
            "ix_entries_user_space_created",
            "user_id",
            "space_id",
            "created_at",
        ),
        Index(
            "ix_entries_user_space_kind_created",
            "user_id",
            "space_id",
            "kind",
            "created_at",
        ),
        Index(
            "ix_entries_superseded_by",
            "superseded_by",
            postgresql_where="superseded_by IS NOT NULL",
        ),
    )
