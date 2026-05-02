"""Refresh and magic-link tokens.

Revision ID: 0002
Revises: 0001
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE refresh_tokens (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL,
            agent_id UUID NOT NULL,
            token_hash VARCHAR(64) NOT NULL UNIQUE,
            expires_at TIMESTAMPTZ NOT NULL,
            issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            revoked_at TIMESTAMPTZ,
            rotated_to_id UUID
        )
        """
    )
    op.execute("CREATE INDEX ix_refresh_tokens_user_id ON refresh_tokens (user_id)")
    op.execute("CREATE INDEX ix_refresh_tokens_agent_id ON refresh_tokens (agent_id)")

    op.execute(
        """
        CREATE TABLE magic_link_tokens (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL,
            token_hash VARCHAR(64) NOT NULL UNIQUE,
            expires_at TIMESTAMPTZ NOT NULL,
            issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            consumed_at TIMESTAMPTZ,
            requesting_ip VARCHAR(45),
            requesting_user_agent VARCHAR(500)
        )
        """
    )
    op.execute("CREATE INDEX ix_magic_link_tokens_user_id ON magic_link_tokens (user_id)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS magic_link_tokens")
    op.execute("DROP TABLE IF EXISTS refresh_tokens")
