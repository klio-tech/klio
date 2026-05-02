"""Access request schemas."""
import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class CreateAccessRequest(BaseModel):
    space_slug: str = Field(..., min_length=1, max_length=100)
    requested_scope: str = Field(..., pattern="^(read|write|admin)$")
    reason: str | None = Field(default=None, max_length=500)


class AccessRequestResponse(BaseModel):
    id: uuid.UUID
    agent_id: uuid.UUID
    space_id: uuid.UUID
    requested_scope: str
    reason: str | None = None
    status: str
    created_at: datetime
    decided_at: datetime | None = None


class DecideAccessRequest(BaseModel):
    grant_scope: str | None = Field(
        default=None, pattern="^(read|write|admin)$"
    )
    """If approving, optionally narrow the scope (e.g., agent asked admin,
    user grants read only). Null => grant the requested_scope."""
