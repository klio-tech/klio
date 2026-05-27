"""Ingest endpoint: transcript -> PII scrub -> extract -> persist."""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.api.auth import RequestContext, require_auth
from klio_engine.audit.writer import write_audit_event
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.dependencies import get_kms, get_session
from klio_engine.models.entry import EntryKind
from klio_engine.models.project import Project
from klio_engine.models.session import Session as SessionModel
from klio_engine.schemas.ingest import IngestTranscriptRequest, IngestTranscriptResponse
from klio_engine.services.acl import ACLDeniedError, check_permission
from klio_engine.services.embeddings import EmbeddingService
from klio_engine.services.entries import EntryService
from klio_engine.services.extractor import FactExtractor
from klio_engine.services.pii import scrub_pii
from klio_engine.services.projects import ProjectService

router = APIRouter(prefix="/v1/spaces/{space_id}/ingest", tags=["ingest"])


@router.post(
    "/transcript",
    response_model=IngestTranscriptResponse,
    status_code=status.HTTP_201_CREATED,
)
async def ingest_transcript(
    space_id: uuid.UUID,
    body: IngestTranscriptRequest,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
    kms: KMSClient = Depends(get_kms),
) -> IngestTranscriptResponse:
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

    transcript = "\n".join(
        f"{m.role.upper()}: {m.content}" for m in body.messages
    )
    scrubbed = scrub_pii(transcript)

    extractor = FactExtractor()
    extracted = await extractor.extract(scrubbed)

    # v0.7.0 per-project scoping. Resolve the project BEFORE creating
    # the Session row so a failure here aborts the whole ingest
    # cleanly (no orphaned Session with a missing project_id).
    #
    # ProjectService.ensure() requires AT LEAST ONE of git_remote /
    # repo_root_path to dedupe a project row (mirrors the partial
    # unique indexes from migration 0008). Pure-cwd ingests — e.g. an
    # MCP client invoked from /tmp with no repo and no remote — get
    # their cwd persisted on the Session row but stay project-NULL,
    # the safe default that surfaces in every project's recall (B2).
    # This is intentional: cwd alone is too weak a signal to spawn a
    # project row (a user's `~` would otherwise become a single
    # "project" containing every ad-hoc memory).
    project: Project | None = None
    if body.git_remote or body.repo_root_path:
        project = await ProjectService().ensure(
            session,
            user_id=ctx.user_id,
            git_remote=body.git_remote,
            repo_root_path=body.repo_root_path,
            # The bridge SHOULD supply project_display_name, but we
            # cannot assume it does — basename of repo_root_path (or
            # cwd as last resort) is the universally-available
            # fallback. _basename_from_path() defends against
            # trailing-slash variants and empty strings.
            display_name=(
                body.project_display_name
                or _basename_from_path(
                    body.repo_root_path or body.cwd or "unknown"
                )
            ),
        )

    # Ensure a Session row exists for this session_id so the FK is valid.
    sess_row = await session.get(SessionModel, body.session_id)
    if sess_row is None:
        sess_row = SessionModel(
            id=body.session_id,
            user_id=ctx.user_id,
            agent_id=ctx.agent_id,
            space_id=space_id,
            source_type=body.source_type,
            # The bridge sends cwd on every hook fire; persisting it
            # on the Session row is the foundation for future "what
            # was I working on at that timestamp" queries. NULL when
            # the caller didn't supply one (e.g. an MCP client
            # outside a repo).
            cwd=body.cwd,
        )
        session.add(sess_row)
        await session.flush()

    embeddings = EmbeddingService()
    entry_svc = EntryService(kms=kms, embeddings=embeddings)

    written_ids: list[uuid.UUID] = []
    project_id = project.id if project is not None else None
    for ee in extracted:
        e = await entry_svc.write(
            session,
            user_id=ctx.user_id,
            space_id=space_id,
            agent_id=ctx.agent_id,
            kind=EntryKind(ee.kind),
            content=ee.content,
            metadata={
                "source_type": body.source_type,
                "session_id": str(body.session_id),
                **(body.metadata or {}),
            },
            confidence=ee.confidence,
            session_id=body.session_id,
            # Tag every extracted entry with the resolved project.
            # NULL when no project context was supplied — that
            # surfaces under any project filter (B2 safe default).
            project_id=project_id,
        )
        written_ids.append(e.id)

    await write_audit_event(
        session,
        user_id=ctx.user_id,
        actor_type="agent",
        actor_id=ctx.agent_id,
        action="transcript.ingest",
        target_type="session",
        target_id=body.session_id,
        metadata={
            "source_type": body.source_type,
            "message_count": len(body.messages),
            "extracted_count": len(extracted),
        },
    )
    await session.commit()
    return IngestTranscriptResponse(
        session_id=body.session_id,
        extracted_count=len(extracted),
        written_entry_ids=written_ids,
    )


def _basename_from_path(path: str) -> str:
    """Last path segment as a display name. Strips trailing slashes.

    Used as a fallback when the bridge doesn't supply
    `project_display_name`. Three small behaviours that matter:

      - Empty string → "unknown" (defensive — should never happen
        since the caller already gated on cwd|remote|path being
        truthy, but a downstream change could regress).
      - Trailing slash stripped before splitting so
        "/Users/dev/repo/" yields "repo", not "".
      - When stripping yields an empty string (e.g. input was
        just "/"), we return the original `path` so the display
        name is at least non-empty.

    Why string-split instead of `pathlib.PurePath`: this MUST work
    for both POSIX paths from the bridge AND URL-style git remotes
    that get fed in as a path fallback. PurePath would normalize
    "git@github.com:org/repo.git" into something surprising. Plain
    string-split on `/` gives the predictable "last segment"
    semantics regardless of input shape.
    """
    if not path:
        return "unknown"
    stripped = path.rstrip("/")
    return stripped.rsplit("/", 1)[-1] or path
