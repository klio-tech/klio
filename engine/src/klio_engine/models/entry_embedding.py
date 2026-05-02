"""Per-dimension shadow tables holding entry embeddings.

pgvector requires a fixed dimension per column, so we maintain one table
per supported dim and pick the correct one at write time based on the
parent space's `embedding_dim`. Each shadow has its own HNSW index. The
`entry_id` is both PK and FK with ON DELETE CASCADE so deleting an entry
cleans up its embedding automatically.

Adding a new dim requires:
  1. New shadow class below.
  2. New row in the migration (drop+create CREATE TABLE).
  3. New entry in `embedding_models.SUPPORTED_DIMS`.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from klio_engine.models.base import Base


class _EmbeddingShadowBase:
    """Mixin for the columns shared across all shadow tables."""

    @classmethod
    def __init_subclass__(cls, **kwargs: object) -> None:  # noqa: D401
        super().__init_subclass__(**kwargs)


class EntryEmbedding768(Base):
    """768-dim shadow — used by ollama/nomic-embed-text and similar."""

    __tablename__ = "entry_embeddings_768"

    entry_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("entries.id", ondelete="CASCADE"),
        primary_key=True,
    )
    embedding: Mapped[list[float]] = mapped_column(Vector(768), nullable=False)
    model: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class EntryEmbedding1024(Base):
    """1024-dim shadow — mxbai-embed-large, snowflake-arctic-embed2, bge-m3."""

    __tablename__ = "entry_embeddings_1024"

    entry_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("entries.id", ondelete="CASCADE"),
        primary_key=True,
    )
    embedding: Mapped[list[float]] = mapped_column(Vector(1024), nullable=False)
    model: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class EntryEmbedding1536(Base):
    """1536-dim shadow — OpenAI text-embedding-3-small, ada-002, stub."""

    __tablename__ = "entry_embeddings_1536"

    entry_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("entries.id", ondelete="CASCADE"),
        primary_key=True,
    )
    embedding: Mapped[list[float]] = mapped_column(Vector(1536), nullable=False)
    model: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# Map dim → shadow class, used by EntryService and RecallService to pick
# the right table without N if-statements.
SHADOW_BY_DIM: dict[int, type[Base]] = {
    768: EntryEmbedding768,
    1024: EntryEmbedding1024,
    1536: EntryEmbedding1536,
}
