"""Access-request endpoints.

The flow:
  1. Agent calls POST /v1/agents/{agent_id}/request-access with a space_slug
     and requested_scope. Engine creates an AccessRequest row and publishes
     a `access.requested` realtime frame so trust-app + daemon can react.
  2. User opens the trust app, sees pending requests at GET /v1/access-requests.
  3. User approves or denies via POST /v1/access-requests/{id}/{approve|deny}.
     On approve: a Permission row is created (or updated). On deny: just
     marks decided_at.
  4. Daemon's realtime subscriber picks up the resulting permission.changed
     frame and refreshes its cached ACL view.
"""
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.api.auth import RequestContext, require_auth
from klio_engine.audit.writer import write_audit_event
from klio_engine.dependencies import get_session
from klio_engine.models.access_request import AccessRequest, AccessRequestStatus
from klio_engine.models.agent import Agent
from klio_engine.models.permission import Permission, PermissionScope
from klio_engine.models.space import Space
from klio_engine.schemas.access_requests import (
    AccessRequestResponse,
    CreateAccessRequest,
    DecideAccessRequest,
)
from klio_engine.services.publisher import RedisPublisher

create_router = APIRouter(
    prefix="/v1/agents/{agent_id}/request-access", tags=["access-requests"]
)
list_router = APIRouter(prefix="/v1/access-requests", tags=["access-requests"])


@create_router.post(
    "", response_model=AccessRequestResponse, status_code=status.HTTP_201_CREATED
)
async def create_request(
    agent_id: uuid.UUID,
    body: CreateAccessRequest,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> AccessRequestResponse:
    """Agent asks the user for permission to a space.

    Authentication: any token belonging to the agent making the request.
    The agent_id in the path MUST match the authenticated agent_id.
    """
    if agent_id != ctx.agent_id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "agent_id mismatch with auth token"
        )

    agent = await session.get(Agent, agent_id)
    if agent is None or agent.user_id != ctx.user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "agent not found")

    # Resolve the space by slug under this user.
    space = (
        await session.execute(
            select(Space).where(
                Space.user_id == ctx.user_id,
                Space.slug == body.space_slug,
                Space.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if space is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"space {body.space_slug} not found"
        )

    # If the agent already has the requested scope, no new request needed.
    existing_perm = (
        await session.execute(
            select(Permission).where(
                Permission.user_id == ctx.user_id,
                Permission.agent_id == agent_id,
                Permission.space_id == space.id,
                Permission.revoked_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if existing_perm is not None:
        wanted = {"read": 0, "write": 1, "admin": 2}[body.requested_scope]
        granted = {"read": 0, "write": 1, "admin": 2}[existing_perm.scope.value]
        if granted >= wanted:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "agent already has at-least the requested scope",
            )

    # Reuse a pending request if one exists for the same (agent, space).
    pending = (
        await session.execute(
            select(AccessRequest).where(
                AccessRequest.user_id == ctx.user_id,
                AccessRequest.agent_id == agent_id,
                AccessRequest.space_id == space.id,
                AccessRequest.status == AccessRequestStatus.PENDING,
            )
        )
    ).scalar_one_or_none()
    if pending is not None:
        return _serialize(pending)

    req = AccessRequest(
        user_id=ctx.user_id,
        agent_id=agent_id,
        space_id=space.id,
        requested_scope=body.requested_scope,
        reason=body.reason,
        status=AccessRequestStatus.PENDING,
        expires_at=datetime.now(UTC) + timedelta(days=7),
    )
    session.add(req)

    await write_audit_event(
        session,
        user_id=ctx.user_id,
        actor_type="agent",
        actor_id=agent_id,
        action="access.requested",
        target_type="space",
        target_id=space.id,
        metadata={"scope": body.requested_scope, "reason": body.reason},
    )
    await session.commit()
    await session.refresh(req)

    # Publish a realtime frame so listeners can react. Best-effort.
    try:
        publisher = RedisPublisher()
        try:
            from klio_engine.services.publisher import RedisPublisher as _pub

            await publisher._client.publish(  # type: ignore[attr-defined]
                f"space:{space.id}",
                f'{{"type":"access.requested","space_id":"{space.id}",'
                f'"frame_id":"{uuid.uuid4()}",'
                f'"access":{{"agent_id":"{agent_id}","scope":"{body.requested_scope}",'
                f'"request_id":"{req.id}"}}}}',
            )
        finally:
            await publisher.close()
            _ = _pub
    except Exception:
        import structlog

        structlog.get_logger().warning(
            "publish_access_requested.failed", request_id=str(req.id)
        )

    return _serialize(req)


@list_router.get("", response_model=list[AccessRequestResponse])
async def list_pending(
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> list[AccessRequestResponse]:
    rows = (
        await session.execute(
            select(AccessRequest)
            .where(
                AccessRequest.user_id == ctx.user_id,
                AccessRequest.status == AccessRequestStatus.PENDING,
            )
            .order_by(AccessRequest.created_at.desc())
        )
    ).scalars().all()
    return [_serialize(r) for r in rows]


@list_router.post("/{request_id}/approve", response_model=AccessRequestResponse)
async def approve(
    request_id: uuid.UUID,
    body: DecideAccessRequest,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> AccessRequestResponse:
    """Approve a pending access request.

    The deciding caller MUST be authenticated as the user (session scope).
    Agent-scope tokens cannot approve; the user has to be in the loop.
    Currently we trust the JWT — a fuller v1 will require recent magic-link
    re-auth for admin-grade scope grants.
    """
    # Approve/deny requires a user-session token. The "session" scope is
    # granted by /v1/users/{id}/verify (magic-link claim flow). Agent
    # tokens (read/write/admin per-space) cannot decide access requests
    # on the user's behalf — that would let an agent escalate itself.
    if "session" not in ctx.scopes:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "user session required"
        )

    req = await _load_pending(session, ctx.user_id, request_id)

    grant_scope = body.grant_scope or req.requested_scope
    # Find or update permission row.
    existing = (
        await session.execute(
            select(Permission).where(
                Permission.user_id == ctx.user_id,
                Permission.space_id == req.space_id,
                Permission.agent_id == req.agent_id,
                Permission.revoked_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        existing.scope = PermissionScope(grant_scope)
        perm = existing
    else:
        perm = Permission(
            user_id=ctx.user_id,
            space_id=req.space_id,
            agent_id=req.agent_id,
            scope=PermissionScope(grant_scope),
            granted_by_user_id=ctx.user_id,
        )
        session.add(perm)
        await session.flush()

    req.status = AccessRequestStatus.APPROVED
    req.decided_at = datetime.now(UTC)
    req.decided_by_user_id = ctx.user_id

    await write_audit_event(
        session,
        user_id=ctx.user_id,
        actor_type="user",
        actor_id=ctx.user_id,
        action="access.approved",
        target_type="permission",
        target_id=perm.id,
        metadata={
            "request_id": str(req.id),
            "agent_id": str(req.agent_id),
            "space_id": str(req.space_id),
            "scope": grant_scope,
        },
    )
    await session.commit()
    await session.refresh(req)

    # Publish permission.changed frame.
    try:
        publisher = RedisPublisher()
        try:
            await publisher.publish_permission_changed(
                space_id=req.space_id,
                agent_id=req.agent_id,
                scope=grant_scope,
            )
        finally:
            await publisher.close()
    except Exception:
        import structlog

        structlog.get_logger().warning(
            "publish_permission_changed.failed", request_id=str(req.id)
        )

    return _serialize(req)


@list_router.post("/{request_id}/deny", response_model=AccessRequestResponse)
async def deny(
    request_id: uuid.UUID,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> AccessRequestResponse:
    if "session" not in ctx.scopes and "admin" not in ctx.scopes:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "user session required to deny"
        )

    req = await _load_pending(session, ctx.user_id, request_id)
    req.status = AccessRequestStatus.DENIED
    req.decided_at = datetime.now(UTC)
    req.decided_by_user_id = ctx.user_id

    await write_audit_event(
        session,
        user_id=ctx.user_id,
        actor_type="user",
        actor_id=ctx.user_id,
        action="access.denied",
        target_type="access_request",
        target_id=req.id,
        metadata={
            "agent_id": str(req.agent_id),
            "space_id": str(req.space_id),
            "scope": req.requested_scope,
        },
    )
    await session.commit()
    await session.refresh(req)
    return _serialize(req)


async def _load_pending(
    session: AsyncSession, user_id: uuid.UUID, request_id: uuid.UUID
) -> AccessRequest:
    req = await session.get(AccessRequest, request_id)
    if req is None or req.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "request not found")
    if req.status != AccessRequestStatus.PENDING:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"request already {req.status.value}"
        )
    return req


def _serialize(r: AccessRequest) -> AccessRequestResponse:
    return AccessRequestResponse(
        id=r.id,
        agent_id=r.agent_id,
        space_id=r.space_id,
        requested_scope=r.requested_scope,
        reason=r.reason,
        status=r.status.value,
        created_at=r.created_at,
        decided_at=r.decided_at,
    )
