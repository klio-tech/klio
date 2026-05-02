"""Agents + audit log endpoints (read-only for v0)."""
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.api.auth import RequestContext, require_auth
from klio_engine.dependencies import get_session
from klio_engine.models.agent import Agent
from klio_engine.models.audit import AuditLogEntry
from klio_engine.schemas.entries import AgentResponse, AuditEntryResponse

agents_router = APIRouter(prefix="/v1/agents", tags=["agents"])
audit_router = APIRouter(prefix="/v1/audit", tags=["audit"])


@agents_router.get("", response_model=list[AgentResponse])
async def list_agents(
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> list[AgentResponse]:
    rows = (
        await session.execute(
            select(Agent)
            .where(Agent.user_id == ctx.user_id, Agent.deleted_at.is_(None))
            .order_by(Agent.created_at)
        )
    ).scalars().all()
    return [
        AgentResponse(
            id=a.id,
            kind=a.kind.value,
            display_name=a.display_name,
            created_at=a.created_at,
        )
        for a in rows
    ]


@audit_router.get("", response_model=list[AuditEntryResponse])
async def list_audit(
    limit: int = 100,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> list[AuditEntryResponse]:
    rows = (
        await session.execute(
            select(AuditLogEntry)
            .where(AuditLogEntry.user_id == ctx.user_id)
            .order_by(AuditLogEntry.created_at.desc())
            .limit(min(max(1, limit), 500))
        )
    ).scalars().all()
    return [
        AuditEntryResponse(
            id=r.id,
            actor_type=r.actor_type,
            action=r.action,
            target_type=r.target_type,
            target_id=r.target_id,
            metadata=r.audit_metadata,
            created_at=r.created_at,
        )
        for r in rows
    ]
