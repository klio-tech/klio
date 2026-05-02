"""Audit notarization records.

Revision ID: 0004
Revises: 0003
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE audit_notarizations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            root_hash VARCHAR(64) NOT NULL,
            ots_attestation BYTEA,
            backend VARCHAR(40) NOT NULL,
            audit_log_count INTEGER NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX ix_audit_notarizations_root_hash ON audit_notarizations (root_hash)"
    )
    op.execute(
        "CREATE INDEX ix_audit_notarizations_created_at ON audit_notarizations (created_at DESC)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS audit_notarizations")
