"""Entry model — the unit of all stored content.

Embeddings are NOT stored on this row. They live in per-dim shadow tables
(`entry_embeddings_768`, `entry_embeddings_1024`, `entry_embeddings_1536`)
keyed by `entry_id`. This keeps the entries table dim-agnostic and lets a
single user run different embedding models in different spaces. See
`klio_engine.models.entry_embedding` for the shadow models and
`klio_engine.services.embedding_models` for the supported-model registry.
"""
import enum
import uuid
from datetime import datetime

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
    # Nullable: legacy entries written before per-project scoping (v0.7.0)
    # and entries from non-repo contexts (e.g. ad-hoc chats with no cwd).
    # SET NULL on delete preserves the entry when its project is removed —
    # the entry simply surfaces in the "uncategorized" bucket that recall
    # always includes alongside the active project's tagged rows.
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="SET NULL"),
        nullable=True,
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
        # Mirrors migration 0008. Recall queries filter by project_id
        # (with NULLs always surfacing); without this index the partition
        # filter would force a sequential scan at row counts > a few
        # hundred per user.
        Index(
            "ix_entries_project_id",
            "project_id",
        ),
    )
