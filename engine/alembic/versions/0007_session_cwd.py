"""Add nullable cwd column to sessions.

The bridge already receives cwd in every hook payload (see
bridge/internal/hooks/types.go::Payload). Persisting it lets us:
  - tag entries with the correct project at write time (Phase C-E),
  - backfill project_id for sessions written between this migration
    and the project-tagging migration (0008) so the window of
    untagged entries stays narrow.

Revision ID: 0007
Revises: 0006
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("cwd", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("sessions", "cwd")
