"""Spaces + per-space ACL endpoints."""
import re
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.api.auth import RequestContext, require_auth
from klio_engine.audit.writer import write_audit_event
from klio_engine.config import Settings
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.dependencies import get_kms, get_session
from klio_engine.models.agent import Agent
from klio_engine.models.permission import Permission, PermissionScope
from klio_engine.models.space import Space
from klio_engine.schemas.spaces import (
    PermissionGrant,
    PermissionResponse,
    ReembedRequest,
    ReembedResponse,
    SpaceCreate,
    SpacePatch,
    SpaceResponse,
)
from klio_engine.services.acl import ACLDeniedError, check_permission
from klio_engine.services.embedding_models import resolve as resolve_embed_model
from klio_engine.services.embeddings import EmbeddingService
from klio_engine.services.reembed import reembed_space

router = APIRouter(prefix="/v1/spaces", tags=["spaces"])
permissions_router = APIRouter(
    prefix="/v1/spaces/{space_id}/permissions", tags=["permissions"]
)

_slug_re = re.compile(r"[^a-z0-9-]+")


def _slugify(name: str) -> str:
    s = _slug_re.sub("-", name.lower()).strip("-")
    return s or "space"


async def _load_owned_space(
    session: AsyncSession, *, user_id: uuid.UUID, space_id: uuid.UUID
) -> Space:
    s = await session.get(Space, space_id)
    if s is None or s.user_id != user_id or s.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "space not found")
    return s


@router.get("", response_model=list[SpaceResponse])
async def list_spaces(
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> list[SpaceResponse]:
    rows = (
        await session.execute(
            select(Space)
            .where(Space.user_id == ctx.user_id, Space.deleted_at.is_(None))
            .order_by(Space.created_at)
        )
    ).scalars().all()
    return [
        SpaceResponse(
            id=s.id,
            name=s.name,
            slug=s.slug,
            embedding_model=s.embedding_model,
            embedding_dim=s.embedding_dim,
            created_at=s.created_at,
        )
        for s in rows
    ]


@router.post("", response_model=SpaceResponse, status_code=status.HTTP_201_CREATED)
async def create_space(
    body: SpaceCreate,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> SpaceResponse:
    slug = body.slug or _slugify(body.name)
    try:
        spec = resolve_embed_model(
            body.embedding_model or Settings().embedding_model
        )
    except ValueError as e:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)
        ) from e
    s = Space(
        user_id=ctx.user_id,
        name=body.name,
        slug=slug,
        embedding_model=spec.name,
        embedding_dim=spec.dim,
    )
    session.add(s)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, "slug already in use for this user"
        ) from None

    # Grant the calling agent admin on the space they just created.
    p = Permission(
        user_id=ctx.user_id,
        space_id=s.id,
        agent_id=ctx.agent_id,
        scope=PermissionScope.ADMIN,
        granted_by_agent_id=ctx.agent_id,
    )
    session.add(p)
    await write_audit_event(
        session,
        user_id=ctx.user_id,
        actor_type="agent",
        actor_id=ctx.agent_id,
        action="space.create",
        target_type="space",
        target_id=s.id,
        metadata={"name": s.name, "slug": s.slug},
    )
    await session.commit()
    return SpaceResponse(
        id=s.id,
        name=s.name,
        slug=s.slug,
        embedding_model=s.embedding_model,
        embedding_dim=s.embedding_dim,
        created_at=s.created_at,
    )


@router.patch("/{space_id}", response_model=SpaceResponse)
async def rename_space(
    space_id: uuid.UUID,
    body: SpacePatch,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> SpaceResponse:
    s = await _load_owned_space(session, user_id=ctx.user_id, space_id=space_id)
    if body.name is not None:
        s.name = body.name
    await write_audit_event(
        session,
        user_id=ctx.user_id,
        actor_type="agent",
        actor_id=ctx.agent_id,
        action="space.rename",
        target_type="space",
        target_id=s.id,
        metadata={"name": s.name},
    )
    await session.commit()
    return SpaceResponse(
        id=s.id,
        name=s.name,
        slug=s.slug,
        embedding_model=s.embedding_model,
        embedding_dim=s.embedding_dim,
        created_at=s.created_at,
    )


@router.post("/{space_id}/reembed", response_model=ReembedResponse)
async def reembed_space_endpoint(
    space_id: uuid.UUID,
    body: ReembedRequest,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
    kms: KMSClient = Depends(get_kms),
) -> ReembedResponse:
    """Re-embed every entry in `space_id` under `body.to_model`.

    Requires admin scope on the space (model swap is operationally
    significant — it can change recall behavior for all callers). The
    endpoint blocks until done; for large spaces, prefer running this
    via the CLI which prints progress.
    """
    try:
        await check_permission(
            session,
            user_id=ctx.user_id,
            agent_id=ctx.agent_id,
            space_id=space_id,
            scope="admin",
        )
    except ACLDeniedError as e:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "admin scope required"
        ) from e

    try:
        result = await reembed_space(
            session,
            kms=kms,
            embeddings=EmbeddingService(),
            user_id=ctx.user_id,
            actor_agent_id=ctx.agent_id,
            space_id=space_id,
            to_model=body.to_model,
        )
    except (ValueError, PermissionError) as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    return ReembedResponse(
        space_id=result.space_id,
        from_model=result.from_model,
        from_dim=result.from_dim,
        to_model=result.to_model,
        to_dim=result.to_dim,
        entries_processed=result.entries_processed,
    )


@router.delete("/{space_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_space(
    space_id: uuid.UUID,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> None:
    s = await _load_owned_space(session, user_id=ctx.user_id, space_id=space_id)
    s.deleted_at = datetime.now(UTC)
    await write_audit_event(
        session,
        user_id=ctx.user_id,
        actor_type="agent",
        actor_id=ctx.agent_id,
        action="space.delete",
        target_type="space",
        target_id=s.id,
        metadata={},
    )
    await session.commit()


# --- Permissions ---


@permissions_router.get("", response_model=list[PermissionResponse])
async def list_permissions(
    space_id: uuid.UUID,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> list[PermissionResponse]:
    try:
        await check_permission(
            session,
            user_id=ctx.user_id,
            agent_id=ctx.agent_id,
            space_id=space_id,
            scope="read",
        )
    except ACLDeniedError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "space not found") from None
    rows = (
        await session.execute(
            select(Permission).where(
                Permission.user_id == ctx.user_id,
                Permission.space_id == space_id,
                Permission.revoked_at.is_(None),
            )
        )
    ).scalars().all()
    return [
        PermissionResponse(
            id=p.id,
            space_id=p.space_id,
            agent_id=p.agent_id,
            scope=p.scope.value,
            granted_at=p.granted_at,
        )
        for p in rows
    ]


@permissions_router.post(
    "", response_model=PermissionResponse, status_code=status.HTTP_201_CREATED
)
async def grant_permission(
    space_id: uuid.UUID,
    body: PermissionGrant,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> PermissionResponse:
    try:
        await check_permission(
            session,
            user_id=ctx.user_id,
            agent_id=ctx.agent_id,
            space_id=space_id,
            scope="admin",
        )
    except ACLDeniedError as e:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "admin scope required"
        ) from e

    target_agent = await session.get(Agent, body.agent_id)
    if target_agent is None or target_agent.user_id != ctx.user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "agent not found")

    if body.scope not in {"read", "write", "admin"}:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid scope")

    # Idempotent: if a non-revoked permission already exists, update its scope.
    existing = (
        await session.execute(
            select(Permission).where(
                Permission.user_id == ctx.user_id,
                Permission.space_id == space_id,
                Permission.agent_id == body.agent_id,
                Permission.revoked_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        existing.scope = PermissionScope(body.scope)
        p = existing
    else:
        p = Permission(
            user_id=ctx.user_id,
            space_id=space_id,
            agent_id=body.agent_id,
            scope=PermissionScope(body.scope),
            granted_by_agent_id=ctx.agent_id,
        )
        session.add(p)
        await session.flush()

    await write_audit_event(
        session,
        user_id=ctx.user_id,
        actor_type="agent",
        actor_id=ctx.agent_id,
        action="permission.grant",
        target_type="permission",
        target_id=p.id,
        metadata={
            "space_id": str(space_id),
            "agent_id": str(body.agent_id),
            "scope": body.scope,
        },
    )
    await session.commit()
    return PermissionResponse(
        id=p.id,
        space_id=p.space_id,
        agent_id=p.agent_id,
        scope=p.scope.value,
        granted_at=p.granted_at,
    )


@permissions_router.delete(
    "/{agent_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def revoke_permission(
    space_id: uuid.UUID,
    agent_id: uuid.UUID,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> None:
    try:
        await check_permission(
            session,
            user_id=ctx.user_id,
            agent_id=ctx.agent_id,
            space_id=space_id,
            scope="admin",
        )
    except ACLDeniedError as e:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "admin scope required"
        ) from e

    p = (
        await session.execute(
            select(Permission).where(
                Permission.user_id == ctx.user_id,
                Permission.space_id == space_id,
                Permission.agent_id == agent_id,
                Permission.revoked_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "permission not found")
    p.revoked_at = datetime.now(UTC)

    await write_audit_event(
        session,
        user_id=ctx.user_id,
        actor_type="agent",
        actor_id=ctx.agent_id,
        action="permission.revoke",
        target_type="permission",
        target_id=p.id,
        metadata={"space_id": str(space_id), "agent_id": str(agent_id)},
    )
    await session.commit()
