"""Entries + recall endpoints."""
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.api.auth import RequestContext, require_auth
from klio_engine.audit.writer import write_audit_event
from klio_engine.config import Settings
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.dependencies import get_kms, get_session
from klio_engine.models.entry import Entry, EntryKind
from klio_engine.schemas.entries import (
    VALID_KINDS_V0,
    EntryResponse,
    EntryWrite,
    RecallRequest,
)
from klio_engine.services.acl import ACLDeniedError, check_permission
from klio_engine.services.embeddings import EmbeddingService
from klio_engine.services.entries import EntryService
from klio_engine.services.publisher import RedisPublisher
from klio_engine.services.recall import RecallService

router = APIRouter(prefix="/v1/spaces/{space_id}/entries", tags=["entries"])
recall_router = APIRouter(prefix="/v1/spaces/{space_id}/recall", tags=["recall"])
entry_delete_router = APIRouter(prefix="/v1/entries", tags=["entries"])


def _entry_service(kms: KMSClient) -> EntryService:
    settings = Settings()
    return EntryService(
        kms=kms,
        embeddings=EmbeddingService(),
        dedup_threshold=settings.dedup_cosine_threshold,
    )


@router.post("", response_model=EntryResponse, status_code=status.HTTP_201_CREATED)
async def write_entry(
    space_id: uuid.UUID,
    body: EntryWrite,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
    kms: KMSClient = Depends(get_kms),
) -> EntryResponse:
    if body.kind not in VALID_KINDS_V0:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"kind must be one of {sorted(VALID_KINDS_V0)}",
        )
    try:
        await check_permission(
            session,
            user_id=ctx.user_id,
            agent_id=ctx.agent_id,
            space_id=space_id,
            scope="write",
        )
    except ACLDeniedError as e:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(e)) from e

    svc = _entry_service(kms)
    e = await svc.write(
        session,
        user_id=ctx.user_id,
        space_id=space_id,
        agent_id=ctx.agent_id,
        kind=EntryKind(body.kind),
        content=body.content,
        metadata=body.metadata,
        confidence=body.confidence,
    )
    await session.commit()

    # Publish for real-time fan-out. Best-effort; never block the write
    # response on a Redis hiccup.
    try:
        publisher = RedisPublisher()
        try:
            await publisher.publish_entry_created(
                space_id=space_id,
                entry={
                    "id": str(e.id),
                    "space_id": str(e.space_id),
                    "agent_id": str(e.agent_id),
                    "kind": e.kind.value,
                    "content": body.content,
                    "confidence": e.confidence,
                    "created_at": e.created_at.isoformat(),
                },
            )
        finally:
            await publisher.close()
    except Exception:
        import structlog

        structlog.get_logger().warning("publish_entry_created.failed", entry_id=str(e.id))

    return EntryResponse(
        id=e.id,
        space_id=e.space_id,
        session_id=e.session_id,
        agent_id=e.agent_id,
        kind=e.kind.value,
        content=body.content,
        metadata=body.metadata,
        confidence=e.confidence,
        created_at=e.created_at,
        superseded_by=e.superseded_by,
    )


@router.get("", response_model=list[EntryResponse])
async def list_entries(
    space_id: uuid.UUID,
    kind: str | None = None,
    since: datetime | None = None,
    limit: int = 100,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
    kms: KMSClient = Depends(get_kms),
) -> list[EntryResponse]:
    try:
        await check_permission(
            session,
            user_id=ctx.user_id,
            agent_id=ctx.agent_id,
            space_id=space_id,
            scope="read",
        )
    except ACLDeniedError as e:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(e)) from e

    q = select(Entry).where(
        Entry.user_id == ctx.user_id,
        Entry.space_id == space_id,
        Entry.deleted_at.is_(None),
    )
    if kind is not None:
        if kind not in VALID_KINDS_V0:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid kind")
        q = q.where(Entry.kind == EntryKind(kind))
    if since is not None:
        q = q.where(Entry.created_at >= since)
    q = q.order_by(Entry.created_at.desc()).limit(min(max(1, limit), 500))

    rows = (await session.execute(q)).scalars().all()
    svc = _entry_service(kms)
    out: list[EntryResponse] = []
    for e in rows:
        content, metadata = await svc.decrypt(session, e, ctx.user_id)
        out.append(
            EntryResponse(
                id=e.id,
                space_id=e.space_id,
                session_id=e.session_id,
                agent_id=e.agent_id,
                kind=e.kind.value,
                content=content,
                metadata=metadata,
                confidence=e.confidence,
                created_at=e.created_at,
                superseded_by=e.superseded_by,
            )
        )
    return out


@recall_router.post("", response_model=list[EntryResponse])
async def recall(
    space_id: uuid.UUID,
    body: RecallRequest,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
    kms: KMSClient = Depends(get_kms),
) -> list[EntryResponse]:
    if body.kind is not None and body.kind not in VALID_KINDS_V0:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid kind")
    try:
        await check_permission(
            session,
            user_id=ctx.user_id,
            agent_id=ctx.agent_id,
            space_id=space_id,
            scope="read",
        )
    except ACLDeniedError as e:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(e)) from e

    embeddings = EmbeddingService()
    recall_svc = RecallService(embeddings=embeddings)
    results = await recall_svc.recall(
        session,
        user_id=ctx.user_id,
        space_id=space_id,
        query=body.query,
        kind=EntryKind(body.kind) if body.kind else None,
        limit=body.limit,
    )

    entry_svc = EntryService(kms=kms, embeddings=embeddings)
    out: list[EntryResponse] = []
    for entry, _score in results:
        content, metadata = await entry_svc.decrypt(session, entry, ctx.user_id)
        out.append(
            EntryResponse(
                id=entry.id,
                space_id=entry.space_id,
                session_id=entry.session_id,
                agent_id=entry.agent_id,
                kind=entry.kind.value,
                content=content,
                metadata=metadata,
                confidence=entry.confidence,
                created_at=entry.created_at,
                superseded_by=entry.superseded_by,
            )
        )
    return out


@entry_delete_router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_entry(
    entry_id: uuid.UUID,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> None:
    e = await session.get(Entry, entry_id)
    if e is None or e.user_id != ctx.user_id or e.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "entry not found")
    e.deleted_at = datetime.now(UTC)
    await write_audit_event(
        session,
        user_id=ctx.user_id,
        actor_type="agent",
        actor_id=ctx.agent_id,
        action="entry.delete",
        target_type="entry",
        target_id=entry_id,
        metadata={"space_id": str(e.space_id), "kind": e.kind.value},
    )
    await session.commit()
