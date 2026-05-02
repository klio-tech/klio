"""Initial schema: extensions, users, agents, spaces, permissions, sessions, entries, audit_log.

Revision ID: 0001
Revises:
Create Date: 2026-05-02
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.execute(
        """
        CREATE TYPE agent_kind AS ENUM (
            'claude-code', 'cursor', 'codex', 'antigravity', 'klio-bridge', 'custom'
        )
        """
    )
    op.execute("CREATE TYPE permission_scope AS ENUM ('read', 'write', 'admin')")
    op.execute(
        """
        CREATE TYPE entry_kind AS ENUM (
            'memory', 'observation', 'plan', 'decision', 'note'
        )
        """
    )

    op.execute(
        """
        CREATE TABLE users (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email_hash VARCHAR(64),
            claimed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deleted_at TIMESTAMPTZ,
            wrapped_envelope_key BYTEA
        )
        """
    )
    op.execute("CREATE INDEX ix_users_email_hash ON users (email_hash) WHERE email_hash IS NOT NULL")

    op.execute(
        """
        CREATE TABLE agents (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            kind agent_kind NOT NULL,
            install_id UUID NOT NULL,
            display_name VARCHAR(200),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deleted_at TIMESTAMPTZ,
            CONSTRAINT uq_agent_user_kind_install UNIQUE (user_id, kind, install_id)
        )
        """
    )
    op.execute("CREATE INDEX ix_agents_user_id ON agents (user_id)")

    op.execute(
        """
        CREATE TABLE spaces (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name VARCHAR(200) NOT NULL,
            slug VARCHAR(100) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deleted_at TIMESTAMPTZ,
            CONSTRAINT uq_space_user_slug UNIQUE (user_id, slug)
        )
        """
    )
    op.execute("CREATE INDEX ix_spaces_user_id ON spaces (user_id)")

    op.execute(
        """
        CREATE TABLE permissions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
            agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            scope permission_scope NOT NULL,
            granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            granted_by_user_id UUID,
            granted_by_agent_id UUID,
            revoked_at TIMESTAMPTZ,
            CONSTRAINT uq_perm_user_space_agent UNIQUE (user_id, space_id, agent_id)
        )
        """
    )

    op.execute(
        """
        CREATE TABLE sessions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ended_at TIMESTAMPTZ,
            source_type VARCHAR(50) NOT NULL
        )
        """
    )

    op.execute(
        """
        CREATE TABLE entries (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
            session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
            agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            kind entry_kind NOT NULL,
            content_ciphertext BYTEA NOT NULL,
            content_nonce BYTEA NOT NULL,
            metadata_ciphertext BYTEA,
            metadata_nonce BYTEA,
            encryption_key_id VARCHAR(200),
            embedding vector(1536) NOT NULL,
            confidence DOUBLE PRECISION NOT NULL DEFAULT 1.0,
            superseded_by UUID REFERENCES entries(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deleted_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        "CREATE INDEX ix_entries_user_space_created ON entries (user_id, space_id, created_at)"
    )
    op.execute(
        "CREATE INDEX ix_entries_user_space_kind_created ON entries "
        "(user_id, space_id, kind, created_at)"
    )
    op.execute(
        "CREATE INDEX ix_entries_superseded_by ON entries (superseded_by) "
        "WHERE superseded_by IS NOT NULL"
    )
    op.execute(
        "CREATE INDEX ix_entries_embedding_hnsw ON entries "
        "USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64) "
        "WHERE deleted_at IS NULL AND superseded_by IS NULL"
    )
    op.execute(
        "CREATE INDEX ix_entries_user_space_active ON entries "
        "(user_id, space_id) WHERE deleted_at IS NULL AND superseded_by IS NULL"
    )

    op.execute(
        """
        CREATE TABLE audit_log (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            actor_type VARCHAR(20) NOT NULL,
            actor_id UUID,
            action VARCHAR(100) NOT NULL,
            target_type VARCHAR(50) NOT NULL,
            target_id UUID,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            prev_hash VARCHAR(64) NOT NULL,
            hash VARCHAR(64) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute("CREATE INDEX ix_audit_log_user_id ON audit_log (user_id, created_at DESC)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS audit_log")
    op.execute("DROP TABLE IF EXISTS entries")
    op.execute("DROP TABLE IF EXISTS sessions")
    op.execute("DROP TABLE IF EXISTS permissions")
    op.execute("DROP TABLE IF EXISTS spaces")
    op.execute("DROP TABLE IF EXISTS agents")
    op.execute("DROP TABLE IF EXISTS users")
    op.execute("DROP TYPE IF EXISTS entry_kind")
    op.execute("DROP TYPE IF EXISTS permission_scope")
    op.execute("DROP TYPE IF EXISTS agent_kind")
