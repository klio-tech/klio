"""Provisioning service end-to-end tests."""
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.audit.chain import compute_hash
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.models.agent import Agent, AgentKind
from klio_engine.models.audit import AuditLogEntry
from klio_engine.models.permission import Permission, PermissionScope
from klio_engine.models.refresh_token import RefreshToken
from klio_engine.models.space import Space
from klio_engine.models.user import User
from klio_engine.services.provisioning import provision_user
from klio_engine.services.user_keys import UserKeyService


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


# --- Idempotency tests for the install_id re-find path ---
#
# The npm CLI's `klio init` is documented as idempotent: re-running it
# with the same persisted install.json must reuse the same user_id so
# the user's prior memories remain accessible. Pre-0.5.2 the engine
# silently violated that contract by always inserting a fresh User()
# row. The tests below pin the contract.


@pytest.mark.asyncio
async def test_provision_user_returns_existing_user_when_install_id_seen_before(
    session: AsyncSession, mock_kms: KMSClient
) -> None:
    """A second call with the same install_id returns the SAME user_id
    as the first call. Memories survive across `klio init` re-runs."""
    install = uuid.uuid4()

    result1 = await provision_user(
        session,
        kms=mock_kms,
        agent_kind="klio-bridge",
        install_id=install,
    )
    await session.flush()

    result2 = await provision_user(
        session,
        kms=mock_kms,
        agent_kind="klio-bridge",
        install_id=install,
    )
    await session.flush()

    assert result1.user_id == result2.user_id
    assert result1.agent_id == result2.agent_id
    assert result1.default_space_id == result2.default_space_id
    # Different api keys (refresh tokens) — each call mints a fresh one.
    assert result1.api_key != result2.api_key
    assert len(result2.api_key) >= 32

    # No duplicate User / Agent / Space rows were created on the second
    # call.
    user_count = (
        await session.execute(select(User))
    ).scalars().all()
    assert len(user_count) == 1
    agent_count = (
        await session.execute(select(Agent))
    ).scalars().all()
    assert len(agent_count) == 1
    space_count = (
        await session.execute(
            select(Space).where(Space.user_id == result1.user_id)
        )
    ).scalars().all()
    assert len(space_count) == 1
    assert space_count[0].slug == "default"


@pytest.mark.asyncio
async def test_provision_user_creates_new_user_for_unseen_install_id(
    session: AsyncSession, mock_kms: KMSClient
) -> None:
    """Cover the existing path explicitly so a future regression that
    breaks new-user creation is caught."""
    install_a = uuid.uuid4()
    install_b = uuid.uuid4()

    r1 = await provision_user(
        session,
        kms=mock_kms,
        agent_kind="klio-bridge",
        install_id=install_a,
    )
    r2 = await provision_user(
        session,
        kms=mock_kms,
        agent_kind="klio-bridge",
        install_id=install_b,
    )

    assert r1.user_id != r2.user_id
    assert r1.agent_id != r2.agent_id
    assert r1.default_space_id != r2.default_space_id


@pytest.mark.asyncio
async def test_provision_user_picks_oldest_when_install_id_has_duplicates(
    session: AsyncSession, mock_kms: KMSClient
) -> None:
    """Production state: a single install_id is associated with multiple
    users (the bug we're fixing left the user's DB in this state). The
    re-find must pick the OLDEST agent's user, because that's the user
    with the longest write history.

    We seed two users sharing one install_id by calling provision_user
    twice with the buggy-style independent paths, then we manually pin
    `created_at` so we know which is older. Then the third call must
    return the older user.
    """
    install = uuid.uuid4()

    # Seed user A directly: insert User -> Agent -> Space without going
    # through provision_user, because provision_user (post-fix) would
    # rebind to the existing user. We need two distinct users sharing
    # one install_id — the broken pre-0.5.2 state.
    keys = UserKeyService(kms=mock_kms)

    user_a = User()
    session.add(user_a)
    await session.flush()
    await keys.provision_user_key(session, user_a)
    agent_a = Agent(
        user_id=user_a.id,
        kind=AgentKind.KLIO_BRIDGE,
        install_id=install,
    )
    # Pin created_at so user_a is unambiguously older.
    agent_a.created_at = datetime.now(UTC) - timedelta(days=10)
    session.add(agent_a)
    await session.flush()
    space_a = Space(
        user_id=user_a.id,
        name="Default",
        slug="default",
    )
    session.add(space_a)
    await session.flush()

    user_b = User()
    session.add(user_b)
    await session.flush()
    await keys.provision_user_key(session, user_b)
    agent_b = Agent(
        user_id=user_b.id,
        kind=AgentKind.KLIO_BRIDGE,
        install_id=install,
    )
    agent_b.created_at = datetime.now(UTC) - timedelta(days=1)
    session.add(agent_b)
    await session.flush()
    space_b = Space(
        user_id=user_b.id,
        name="Default",
        slug="default",
    )
    session.add(space_b)
    await session.flush()

    # Third provision call with the duplicated install_id: must pick
    # user_a (older).
    result = await provision_user(
        session,
        kms=mock_kms,
        agent_kind="klio-bridge",
        install_id=install,
    )

    assert result.user_id == user_a.id
    assert result.agent_id == agent_a.id
    assert result.default_space_id == space_a.id


@pytest.mark.asyncio
async def test_provision_user_audit_log_records_created_flag(
    session: AsyncSession, mock_kms: KMSClient
) -> None:
    """New-user path: audit row metadata.created == True.
    Re-find path: audit row metadata.created == False.

    Lets operators tell from the audit chain whether a provision call
    created or re-found.
    """
    install = uuid.uuid4()

    # First provision creates the user.
    result1 = await provision_user(
        session,
        kms=mock_kms,
        agent_kind="klio-bridge",
        install_id=install,
    )

    new_user_audit = (
        await session.execute(
            select(AuditLogEntry)
            .where(
                AuditLogEntry.user_id == result1.user_id,
                AuditLogEntry.action == "user.provision",
            )
            .order_by(AuditLogEntry.created_at.asc())
        )
    ).scalars().all()
    assert len(new_user_audit) == 1
    assert new_user_audit[0].audit_metadata.get("created") is True

    # Second provision re-finds the same user.
    result2 = await provision_user(
        session,
        kms=mock_kms,
        agent_kind="klio-bridge",
        install_id=install,
    )

    assert result2.user_id == result1.user_id

    refind_audit = (
        await session.execute(
            select(AuditLogEntry)
            .where(
                AuditLogEntry.user_id == result1.user_id,
                AuditLogEntry.action == "user.provision",
            )
            .order_by(AuditLogEntry.created_at.asc())
        )
    ).scalars().all()
    assert len(refind_audit) == 2
    # The newly-appended row records created=False.
    assert refind_audit[-1].audit_metadata.get("created") is False

    # The audit chain remains intact across the re-find row: its
    # prev_hash equals the hash of the immediately-preceding row in
    # the user's chain (which is the permission.grant from the
    # original new-user provision, not the previous user.provision).
    all_rows = (
        await session.execute(
            select(AuditLogEntry)
            .where(AuditLogEntry.user_id == result1.user_id)
            .order_by(AuditLogEntry.created_at.asc())
        )
    ).scalars().all()
    # Original 3 (user.provision, space.create, permission.grant)
    # plus 1 re-find user.provision = 4 rows total.
    assert len(all_rows) == 4
    assert [r.action for r in all_rows] == [
        "user.provision",
        "space.create",
        "permission.grant",
        "user.provision",
    ]
    for prev_row, curr_row in zip(all_rows, all_rows[1:]):
        assert curr_row.prev_hash == prev_row.hash
