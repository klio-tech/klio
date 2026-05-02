"""User-related request/response schemas."""
import uuid

from pydantic import BaseModel, EmailStr


class ProvisionRequest(BaseModel):
    agent_kind: str
    install_id: uuid.UUID
    display_name: str | None = None
    email: EmailStr | None = None


class ProvisionResponse(BaseModel):
    user_id: uuid.UUID
    agent_id: uuid.UUID
    api_key: str
    claimed: bool
    default_space_id: uuid.UUID


class ClaimRequest(BaseModel):
    email: EmailStr


class ClaimResponse(BaseModel):
    magic_link_sent: bool = True
    expires_in_minutes: int = 15


class VerifyRequest(BaseModel):
    token: str


class VerifyResponse(BaseModel):
    user_id: uuid.UUID
    session_token: str
    access_token: str


class RefreshRequest(BaseModel):
    refresh_token: str


class RefreshResponse(BaseModel):
    access_token: str
    refresh_token: str
    expires_in: int


class LoginLinkRequest(BaseModel):
    email: EmailStr


class LoginLinkResponse(BaseModel):
    """Always returns ok=True regardless of whether the email matched any
    user. This avoids leaking which emails are registered.
    """

    ok: bool = True
    expires_in_minutes: int = 15
