"""Space schemas."""
import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class SpaceCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    slug: str | None = None
    embedding_model: str | None = Field(
        default=None,
        description=(
            "Optional override for the space's embedding model. Must be a "
            "name from the EMBEDDING_MODELS registry. If omitted, the "
            "deployment's default (KLIO_EMBEDDING_MODEL) is used. The pin "
            "is permanent for the life of the space."
        ),
    )


class SpacePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)


class SpaceResponse(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    embedding_model: str
    embedding_dim: int
    created_at: datetime


class ReembedRequest(BaseModel):
    to_model: str = Field(..., description="Target embedding model name")


class ReembedResponse(BaseModel):
    space_id: uuid.UUID
    from_model: str
    from_dim: int
    to_model: str
    to_dim: int
    entries_processed: int


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
