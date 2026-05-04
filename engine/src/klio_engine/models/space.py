"""Space model — user-named container for entries.

Each space pins its own embedding model + dimension at creation time. The
pin is permanent for the life of the space; switching models requires a
re-embed migration (see `klio reembed --space <id> --to <model>`). This
isolation means one user can run different spaces on different embedding
backends (e.g. nomic for cheap recall, openai for highest quality)
without a global schema change.
"""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from klio_engine.models.base import Base


def _default_embedding_model() -> str:
    """Resolved at INSERT time so KLIO_EMBEDDING_MODEL env overrides work
    in tests and CLI scripts without explicit kwarg threading.

    Uses `resolve_or_synthesize` so non-registry model names (e.g.
    `custom/<model>`, escape-hatch `openrouter/<model>` picks the npm
    onboarding probed end-to-end) resolve to the user-supplied name
    rather than raising. The synthesized spec preserves the original
    name so the Space row records exactly what the user picked.
    """
    from klio_engine.config import Settings
    from klio_engine.services.embedding_models import resolve_or_synthesize

    s = Settings()
    return resolve_or_synthesize(s.embedding_model, s.embedding_dim).name


def _default_embedding_dim() -> int:
    """Resolved at INSERT time. Source-of-truth order:

      1. Registry hit on `KLIO_EMBEDDING_MODEL` -> registry's dim.
      2. Registry miss + `KLIO_EMBEDDING_DIM` set -> the env's dim
         (npm onboarding probed it against the user's provider).
      3. Registry miss + no env dim -> raise (resolve_or_synthesize),
         which surfaces a clear error rather than silently storing
         vectors with the wrong dim.
    """
    from klio_engine.config import Settings
    from klio_engine.services.embedding_models import resolve_or_synthesize

    s = Settings()
    return resolve_or_synthesize(s.embedding_model, s.embedding_dim).dim


class Space(Base):
    """A user-named container. Slug is unique per user."""

    __tablename__ = "spaces"
    __table_args__ = (
        UniqueConstraint("user_id", "slug", name="uq_space_user_slug"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    slug: Mapped[str] = mapped_column(String(100), nullable=False)
    embedding_model: Mapped[str] = mapped_column(
        String(120), nullable=False, default=_default_embedding_model
    )
    embedding_dim: Mapped[int] = mapped_column(
        Integer, nullable=False, default=_default_embedding_dim
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
