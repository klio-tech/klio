"""Ingest endpoint: transcript -> PII scrub -> extract -> persist."""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.api.auth import RequestContext, require_auth
from klio_engine.audit.writer import write_audit_event
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.dependencies import get_kms, get_session
from klio_engine.models.entry import EntryKind
from klio_engine.models.session import Session as SessionModel
from klio_engine.schemas.ingest import IngestTranscriptRequest, IngestTranscriptResponse
from klio_engine.services.acl import ACLDeniedError, check_permission
from klio_engine.services.embeddings import EmbeddingService
from klio_engine.services.entries import EntryService
from klio_engine.services.extractor import FactExtractor
from klio_engine.services.pii import scrub_pii

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

    # Ensure a Session row exists for this session_id so the FK is valid.
    sess_row = await session.get(SessionModel, body.session_id)
    if sess_row is None:
        sess_row = SessionModel(
            id=body.session_id,
            user_id=ctx.user_id,
            agent_id=ctx.agent_id,
            space_id=space_id,
            source_type=body.source_type,
        )
        session.add(sess_row)
        await session.flush()

    embeddings = EmbeddingService()
    entry_svc = EntryService(kms=kms, embeddings=embeddings)

    written_ids: list[uuid.UUID] = []
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
