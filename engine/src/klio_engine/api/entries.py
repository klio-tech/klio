"""Entries + recall endpoints."""
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.api.auth import RequestContext, require_auth
from klio_engine.audit.writer import write_audit_event
from klio_engine.config import Settings
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.dependencies import get_kms, get_session
from klio_engine.models.entry import Entry, EntryKind
from klio_engine.models.project import Project
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


def _entry_to_response(
    entry: Entry, *, content: str, metadata: dict[str, Any] | None
) -> EntryResponse:
    """Build the API response shape from an Entry ORM row + its
    already-resolved content/metadata.

    Content + metadata are passed in (not read off `entry`) because
    the read paths supply DECRYPTED values while the write path
    supplies the caller's plaintext — the caller owns that resolution,
    this helper owns the field mapping. Centralizing it means a new
    EntryResponse field is a one-line change here, not a three-site
    hunt (project_id and session_id both previously required touching
    all three sites in lockstep).
    """
    return EntryResponse(
        id=entry.id,
        space_id=entry.space_id,
        session_id=entry.session_id,
        agent_id=entry.agent_id,
        project_id=entry.project_id,
        kind=entry.kind.value,
        content=content,
        metadata=metadata,
        confidence=entry.confidence,
        created_at=entry.created_at,
        superseded_by=entry.superseded_by,
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
        # v0.7.0 per-project scoping. Optional; NULL is the safe
        # default that surfaces under any project filter (B2). We do
        # NOT validate that the project_id belongs to the caller here
        # — the entries.project_id FK uses ON DELETE SET NULL and is
        # not cross-tenant scoped at the DB level. Tenant ownership
        # checks for project_id will land in F1 (the promote endpoint)
        # when it becomes addressable from the public API. For C1, the
        # bridge supplies project_ids it freshly resolved via the
        # ingest flow under its own auth — there's no cross-tenant
        # surface yet.
        project_id=body.project_id,
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

    # write_entry returns the caller's plaintext content/metadata
    # (what they just sent), NOT a decrypt round-trip — the row is
    # freshly written so the values are already in hand.
    return _entry_to_response(e, content=body.content, metadata=body.metadata)


@router.get("", response_model=list[EntryResponse])
async def list_entries(
    space_id: uuid.UUID,
    kind: str | None = None,
    since: datetime | None = None,
    project_id: uuid.UUID | None = None,
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
    if project_id is not None:
        # Mirror recall's B2 semantics: NULL-tagged (legacy /
        # uncategorized) entries surface alongside the selected
        # project's entries. A user browsing "klio-tech/klio" still
        # sees their pre-0.7.0 global pool, which is the safe default
        # that avoids "where did my old memories go".
        #
        # We take a `uuid.UUID` directly here (NOT recall's richer
        # `project` string form that resolves remote / "any"): the
        # trust-app dashboard always has the project UUID in hand from
        # GET /v1/projects, so the string-resolution branches recall
        # needs for agent-driven calls add no value on this browse
        # path.
        #
        # No ownership check / 404 on an unknown project_id: the filter
        # is a browse convenience, not a correctness-critical read. An
        # unknown id (e.g. a stale dashboard tab) simply resolves to
        # the NULL-tagged subset — the project-match branch matches
        # nothing while the OR-NULL branch still applies. This leaks
        # nothing (the outer `Entry.user_id == ctx.user_id` predicate
        # already tenant-scopes every row) and never silently widens to
        # cross-project results, so the harmless-subset behavior is
        # strictly safer than 404-ing a stale-tab request.
        q = q.where(
            (Entry.project_id == project_id) | (Entry.project_id.is_(None))
        )
    q = q.order_by(Entry.created_at.desc()).limit(min(max(1, limit), 500))

    rows = (await session.execute(q)).scalars().all()
    svc = _entry_service(kms)
    out: list[EntryResponse] = []
    for e in rows:
        content, metadata = await svc.decrypt(session, e, ctx.user_id)
        out.append(_entry_to_response(e, content=content, metadata=metadata))
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

    # Resolve the optional `project` filter AFTER auth/ACL — leaks
    # nothing about project existence to unauthorised callers. The
    # helper returns None for "cross-project" (preserves v0.6 behaviour)
    # and raises HTTPException(404) for anything that doesn't match a
    # project the caller owns (never silently widens — that would be
    # the footgun B3 is designed to prevent).
    project_id = await _resolve_project_arg(session, ctx.user_id, body.project)

    embeddings = EmbeddingService()
    recall_svc = RecallService(embeddings=embeddings)
    results = await recall_svc.recall(
        session,
        user_id=ctx.user_id,
        space_id=space_id,
        query=body.query,
        kind=EntryKind(body.kind) if body.kind else None,
        project_id=project_id,
        limit=body.limit,
    )

    entry_svc = EntryService(kms=kms, embeddings=embeddings)
    out: list[EntryResponse] = []
    for entry, _score in results:
        content, metadata = await entry_svc.decrypt(session, entry, ctx.user_id)
        out.append(_entry_to_response(entry, content=content, metadata=metadata))
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


async def _resolve_project_arg(
    session: AsyncSession, user_id: uuid.UUID, raw: str | None
) -> uuid.UUID | None:
    """Resolve a recall request's `project` string to a project_id.

    Returns None for None or "any" (cross-project recall — caller
    passes None to RecallService). Returns a UUID for a tenant-owned
    project matching either the raw UUID or the git_remote string.
    Raises HTTPException(404) when a non-empty/non-"any" value
    doesn't match any project the caller owns — 404 (not 422) because
    the project IS a resource being addressed.

    The 404-not-422 distinction is load-bearing: returning 422 ("bad
    schema") would suggest the client can fix the body and retry,
    when in fact the body IS well-formed — the referenced project
    simply doesn't exist for this tenant. 404 surfaces that as
    "addressed resource not found" so clients route the error
    correctly. It also dodges the silent-widening footgun: a typo'd
    project that resolved to None would quietly return cross-project
    results (everything the user can see), the exact failure mode
    the per-project scoping design forbids.
    """
    # Normalize: strip whitespace, treat empty as None. A bridge that
    # sends " any" or "" should behave the same as omitting the field.
    # Otherwise users get a confusing 404 ("project not found: ") from
    # what's almost certainly a client-side bug, not a real lookup.
    if raw is not None:
        raw = raw.strip()
        if raw == "":
            raw = None

    if raw is None or raw == "any":
        return None

    # UUID branch — try parsing first so a UUID-shaped `raw` is
    # resolved against `projects.id` rather than `projects.git_remote`.
    # ValueError from uuid.UUID() means it isn't UUID-shaped → fall
    # through to the git_remote lookup.
    try:
        candidate = uuid.UUID(raw)
    except ValueError:
        candidate = None

    if candidate is not None:
        stmt = select(Project.id).where(
            Project.id == candidate, Project.user_id == user_id
        )
        result = (await session.execute(stmt)).scalar_one_or_none()
        if result is not None:
            return result
        # UUID was well-formed but didn't match any project this
        # user owns. Don't fall through to the git_remote branch —
        # a UUID can't be a git remote URL, so further lookup is
        # guaranteed to miss. 404 immediately.
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"project not found: {raw}"
        )

    # git_remote branch — `raw` is a non-UUID string. Look it up in
    # `projects.git_remote` scoped to the caller. We do NOT check
    # `repo_root_path` here: the bridge passes the strongest
    # identifier available, and the path-only case only occurs when
    # there's no git remote — which means the caller can't know the
    # path to pass anyway. If repo_root_path lookups become a
    # use-case (e.g. CLI tools), extend this branch then.
    stmt = select(Project.id).where(
        Project.user_id == user_id, Project.git_remote == raw
    )
    result = (await session.execute(stmt)).scalar_one_or_none()
    if result is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"project not found: {raw}"
        )
    return result
