"""CuratorState — per-user cursor for the background curator.

One row per user, created lazily on the first curator tick for that
user. The row is the source of truth for "what observations have
already been processed" — its `last_cursor_at` advances only after
the synthesised entries commit.

See docs/plans/2026-05-06-klio-curator-design.md for the full
semantics, including failure modes (cursor stays put on LLM
unreachable, advances only on transactional success)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, Text, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from klio_engine.models.base import Base


class CuratorState(Base):
    __tablename__ = "curator_state"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    # Wall-clock of the most recent tick attempt (success or failure).
    # Surfaces in `klio status` as "last run Nm ago".
    last_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # High-water mark on `entries.created_at` for kind=observation.
    # The next tick reads strictly-greater-than this value.
    last_cursor_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("'1970-01-01 00:00:00+00'::timestamptz"),
        index=True,
    )
    runs_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_synthesized: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
