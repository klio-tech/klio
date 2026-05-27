"""Project model — auto-detected per-repo memory partition.

The bridge resolves a working directory to a project (git remote URL →
repo root abspath → cwd abspath) on every hook fire. Every entry it
writes gets tagged with the resolved project_id. Recall defaults to
filtering by the active project — see
docs/plans/2026-05-27-per-project-memory-scoping-design.md.

The user never directly creates these. Get-or-create logic lives in
`klio_engine.services.projects.ProjectService.ensure` (task B1).

Schema (from migration 0008):
  - id, user_id (FK, CASCADE on delete)
  - git_remote (Text, nullable) — strongest project identifier
  - repo_root_path (Text, nullable) — fallback when no git remote
  - display_name (String(200), NOT NULL) — UI label
  - dedicated_space_id (FK to spaces, nullable, SET NULL on delete)
    — set by the promote-to-space escape valve when this project
    needs its own space (e.g., a different embedding model)
  - created_at, last_seen_at (timestamptz, default now())

Uniqueness is enforced by two partial indexes mirrored from
migration 0008. Declaring them on the ORM keeps
`Base.metadata.create_all` (used by the per-test schema fixture in
`tests/conftest.py`) in lockstep with Alembic-built schemas —
without this, unit tests would happily insert duplicates that real
deployments would reject.
  - ix_projects_user_remote  WHERE git_remote IS NOT NULL
  - ix_projects_user_path    WHERE git_remote IS NULL AND
                                   repo_root_path IS NOT NULL
"""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from klio_engine.models.base import Base


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    git_remote: Mapped[str | None] = mapped_column(Text, nullable=True)
    repo_root_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    dedicated_space_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("spaces.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        Index(
            "ix_projects_user_remote",
            "user_id",
            "git_remote",
            unique=True,
            postgresql_where="git_remote IS NOT NULL",
        ),
        Index(
            "ix_projects_user_path",
            "user_id",
            "repo_root_path",
            unique=True,
            postgresql_where=(
                "git_remote IS NULL AND repo_root_path IS NOT NULL"
            ),
        ),
    )
