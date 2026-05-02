"""Provisioning service end-to-end tests."""
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.audit.chain import compute_hash
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.models.agent import Agent
from klio_engine.models.audit import AuditLogEntry
from klio_engine.models.permission import Permission, PermissionScope
from klio_engine.models.refresh_token import RefreshToken
from klio_engine.models.space import Space
from klio_engine.models.user import User
from klio_engine.services.provisioning import provision_user


@pytest.mark.asyncio
async def test_provisions_full_state(
    session: AsyncSession, mock_kms: KMSClient
) -> None:
    install = uuid.uuid4()
    result = await provision_user(
        session,
        kms=mock_kms,
        agent_kind="claude-code",
        install_id=install,
        display_name="Claude Code on dev",
    )

    # Verify all rows exist
    user = await session.get(User, result.user_id)
    assert user is not None
    assert user.wrapped_envelope_key is not None
    assert user.email_hash is None  # anonymous

    agent = await session.get(Agent, result.agent_id)
    assert agent is not None
    assert agent.kind.value == "claude-code"
    assert agent.install_id == install

    space = await session.get(Space, result.default_space_id)
    assert space is not None
    assert space.slug == "default"

    perm = (
        await session.execute(
            select(Permission).where(
                Permission.user_id == user.id,
                Permission.space_id == space.id,
                Permission.agent_id == agent.id,
            )
        )
    ).scalar_one()
    assert perm.scope is PermissionScope.ADMIN

    rt = (
        await session.execute(
            select(RefreshToken).where(RefreshToken.user_id == user.id)
        )
    ).scalar_one()
    assert rt.revoked_at is None
    assert len(result.api_key) >= 32


@pytest.mark.asyncio
async def test_audit_log_chain_intact(
    session: AsyncSession, mock_kms: KMSClient
) -> None:
    result = await provision_user(
        session,
        kms=mock_kms,
        agent_kind="claude-code",
        install_id=uuid.uuid4(),
    )

    audit_rows = (
        await session.execute(
            select(AuditLogEntry)
            .where(AuditLogEntry.user_id == result.user_id)
            .order_by(AuditLogEntry.created_at)
        )
    ).scalars().all()

    # Three actions: user.provision, space.create, permission.grant
    assert len(audit_rows) == 3
    actions = [r.action for r in audit_rows]
    assert actions == ["user.provision", "space.create", "permission.grant"]

    # Verify hash chain: each row's prev_hash == previous row's hash
    prev_hash = "0" * 64
    for row in audit_rows:
        assert row.prev_hash == prev_hash
        # Recompute and check
        from klio_engine.audit.chain import AuditEvent

        recomputed = compute_hash(
            AuditEvent(
                id=row.id,
                user_id=row.user_id,
                actor_type=row.actor_type,
                actor_id=row.actor_id,
                action=row.action,
                target_type=row.target_type,
                target_id=row.target_id,
                metadata=row.audit_metadata,
                prev_hash=row.prev_hash,
                created_at=row.created_at,
            )
        )
        assert recomputed == row.hash
        prev_hash = row.hash


@pytest.mark.asyncio
async def test_provision_with_email_sets_hash(
    session: AsyncSession, mock_kms: KMSClient
) -> None:
    result = await provision_user(
        session,
        kms=mock_kms,
        agent_kind="claude-code",
        install_id=uuid.uuid4(),
        email="abhishek@example.com",
    )
    user = await session.get(User, result.user_id)
    assert user is not None
    import hashlib

    assert user.email_hash == hashlib.sha256(b"abhishek@example.com").hexdigest()
