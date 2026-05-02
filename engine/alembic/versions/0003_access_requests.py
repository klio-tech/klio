"""AccessRequest table for cross-agent access requests.

Revision ID: 0003
Revises: 0002
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "CREATE TYPE access_request_status AS ENUM "
        "('pending', 'approved', 'denied', 'expired')"
    )
    op.execute(
        """
        CREATE TABLE access_requests (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
            requested_scope VARCHAR(20) NOT NULL,
            reason VARCHAR(500),
            status access_request_status NOT NULL DEFAULT 'pending',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ,
            decided_at TIMESTAMPTZ,
            decided_by_user_id UUID
        )
        """
    )
    op.execute(
        "CREATE INDEX ix_access_requests_user_status ON access_requests "
        "(user_id, status, created_at DESC)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS access_requests")
    op.execute("DROP TYPE IF EXISTS access_request_status")
