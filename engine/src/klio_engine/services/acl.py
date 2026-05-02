"""ACL enforcement.

The contract: check_permission raises ACLDeniedError if the (user, agent, space, scope)
tuple is not satisfied by an active grant. Validates:
  - Agent belongs to user_id (defense-in-depth against forged tokens)
  - Space belongs to user_id (same)
  - Permission row exists and is not revoked
  - Scope is satisfied (admin > write > read)
"""
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.agent import Agent
from klio_engine.models.permission import Permission
from klio_engine.models.space import Space


_SCOPE_ORDER = {"read": 0, "write": 1, "admin": 2}


class ACLDeniedError(Exception):
    """Raised when a permission check fails. Always returns 403 to clients."""


async def check_permission(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    agent_id: uuid.UUID,
    space_id: uuid.UUID,
    scope: str,
) -> None:
    if scope not in _SCOPE_ORDER:
        raise ValueError(f"unknown scope {scope!r}")

    agent = await session.get(Agent, agent_id)
    if agent is None or agent.user_id != user_id:
        raise ACLDeniedError("agent not owned by user")
    space = await session.get(Space, space_id)
    if space is None or space.user_id != user_id:
        raise ACLDeniedError("space not owned by user")

    p = (
        await session.execute(
            select(Permission).where(
                Permission.user_id == user_id,
                Permission.agent_id == agent_id,
                Permission.space_id == space_id,
                Permission.revoked_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if p is None:
        raise ACLDeniedError("no permission")

    granted = _SCOPE_ORDER[p.scope.value]
    needed = _SCOPE_ORDER[scope]
    if granted < needed:
        raise ACLDeniedError(f"scope {p.scope.value!r} insufficient for {scope!r}")
