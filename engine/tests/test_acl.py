"""ACL service tests, including cross-tenant isolation."""
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.agent import Agent, AgentKind
from klio_engine.models.permission import Permission, PermissionScope
from klio_engine.models.space import Space
from klio_engine.models.user import User
from klio_engine.services.acl import ACLDeniedError, check_permission


async def _make_user_agent_space(session: AsyncSession):
    u = User()
    session.add(u)
    await session.flush()
    a = Agent(user_id=u.id, kind=AgentKind.CLAUDE_CODE, install_id=uuid.uuid4())
    s = Space(user_id=u.id, name="X", slug="x")
    session.add_all([a, s])
    await session.flush()
    return u, a, s


@pytest.mark.asyncio
async def test_explicit_grant_passes(session: AsyncSession) -> None:
    u, a, s = await _make_user_agent_space(session)
    p = Permission(user_id=u.id, space_id=s.id, agent_id=a.id, scope=PermissionScope.READ)
    session.add(p)
    await session.flush()
    await check_permission(
        session, user_id=u.id, agent_id=a.id, space_id=s.id, scope="read"
    )


@pytest.mark.asyncio
async def test_no_grant_raises(session: AsyncSession) -> None:
    u, a, s = await _make_user_agent_space(session)
    with pytest.raises(ACLDeniedError):
        await check_permission(
            session, user_id=u.id, agent_id=a.id, space_id=s.id, scope="read"
        )


@pytest.mark.asyncio
async def test_revoked_grant_raises(session: AsyncSession) -> None:
    u, a, s = await _make_user_agent_space(session)
    p = Permission(
        user_id=u.id, space_id=s.id, agent_id=a.id,
        scope=PermissionScope.READ, revoked_at=datetime.now(UTC),
    )
    session.add(p)
    await session.flush()
    with pytest.raises(ACLDeniedError):
        await check_permission(
            session, user_id=u.id, agent_id=a.id, space_id=s.id, scope="read"
        )


@pytest.mark.asyncio
async def test_write_requires_write_or_admin(session: AsyncSession) -> None:
    u, a, s = await _make_user_agent_space(session)
    p = Permission(user_id=u.id, space_id=s.id, agent_id=a.id, scope=PermissionScope.READ)
    session.add(p)
    await session.flush()
    with pytest.raises(ACLDeniedError):
        await check_permission(
            session, user_id=u.id, agent_id=a.id, space_id=s.id, scope="write"
        )


@pytest.mark.asyncio
async def test_admin_satisfies_all_scopes(session: AsyncSession) -> None:
    u, a, s = await _make_user_agent_space(session)
    p = Permission(user_id=u.id, space_id=s.id, agent_id=a.id, scope=PermissionScope.ADMIN)
    session.add(p)
    await session.flush()
    for scope in ["read", "write", "admin"]:
        await check_permission(
            session, user_id=u.id, agent_id=a.id, space_id=s.id, scope=scope
        )


@pytest.mark.asyncio
async def test_cross_user_access_denied(session: AsyncSession) -> None:
    """Critical: user A's agent must NEVER access user B's space."""
    u_a = User()
    u_b = User()
    session.add_all([u_a, u_b])
    await session.flush()
    agent_a = Agent(user_id=u_a.id, kind=AgentKind.CLAUDE_CODE, install_id=uuid.uuid4())
    space_b = Space(user_id=u_b.id, name="B", slug="b")
    session.add_all([agent_a, space_b])
    await session.flush()

    # Even with a forged user_id, the space ownership check fails.
    with pytest.raises(ACLDeniedError):
        await check_permission(
            session,
            user_id=u_b.id,
            agent_id=agent_a.id,
            space_id=space_b.id,
            scope="read",
        )
