"""Entry schemas."""
import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


VALID_KINDS_V0 = {"memory", "observation", "plan", "decision", "note"}


class EntryWrite(BaseModel):
    kind: str
    content: str = Field(..., min_length=1, max_length=50_000)
    metadata: dict[str, Any] | None = None
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)


class EntryResponse(BaseModel):
    id: uuid.UUID
    space_id: uuid.UUID
    session_id: uuid.UUID | None = None
    agent_id: uuid.UUID
    kind: str
    content: str
    metadata: dict[str, Any] | None = None
    confidence: float
    created_at: datetime
    superseded_by: uuid.UUID | None = None


class RecallRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=2_000)
    kind: str | None = None
    limit: int = Field(default=10, ge=1, le=100)


class AgentResponse(BaseModel):
    id: uuid.UUID
    kind: str
    display_name: str | None
    created_at: datetime


class AuditEntryResponse(BaseModel):
    id: uuid.UUID
    actor_type: str
    action: str
    target_type: str
    target_id: uuid.UUID | None = None
    metadata: dict[str, Any]
    created_at: datetime
