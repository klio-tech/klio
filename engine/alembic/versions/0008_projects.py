"""Add projects table and entries.project_id FK.

Every entry written via the bridge gets tagged with the project
that originated it (auto-detected by the bridge from cwd → git
remote → repo root path). Recall defaults filter by current
project; explicit overrides widen. See
docs/plans/2026-05-27-per-project-memory-scoping-design.md.

Uniqueness: git_remote dominates when present (canonical across
machines + worktrees); repo_root_path is the fallback for non-git
folders. Two partial unique indexes encode this exactly — no
CHECK constraint needed.

`dedicated_space_id` is the promote-to-space escape valve: when set,
that project's writes/reads route to a dedicated space (e.g. for a
project that needs a different embedding model or isolated KMS key).

Revision ID: 0008
Revises: 0007
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("git_remote", sa.Text(), nullable=True),
        sa.Column("repo_root_path", sa.Text(), nullable=True),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column(
            "dedicated_space_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("spaces.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    # Partial unique indexes: git_remote when present; repo_root_path otherwise.
    op.create_index(
        "projects_user_remote_idx",
        "projects",
        ["user_id", "git_remote"],
        unique=True,
        postgresql_where=sa.text("git_remote IS NOT NULL"),
    )
    op.create_index(
        "projects_user_path_idx",
        "projects",
        ["user_id", "repo_root_path"],
        unique=True,
        postgresql_where=sa.text("git_remote IS NULL AND repo_root_path IS NOT NULL"),
    )

    op.add_column(
        "entries",
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("entries_project_id_idx", "entries", ["project_id"])


def downgrade() -> None:
    op.drop_index("entries_project_id_idx", table_name="entries")
    op.drop_column("entries", "project_id")
    op.drop_index("projects_user_path_idx", table_name="projects")
    op.drop_index("projects_user_remote_idx", table_name="projects")
    op.drop_table("projects")
