"""Space schemas."""
import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class SpaceCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    slug: str | None = None


class SpacePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)


class SpaceResponse(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    created_at: datetime


class PermissionGrant(BaseModel):
    agent_id: uuid.UUID
    scope: str


class PermissionResponse(BaseModel):
    id: uuid.UUID
    space_id: uuid.UUID
    agent_id: uuid.UUID
    scope: str
    granted_at: datetime
    revoked_at: datetime | None = None
