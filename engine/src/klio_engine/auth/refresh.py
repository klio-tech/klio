"""Refresh-token lifecycle. One-time-use rotation."""
import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.refresh_token import RefreshToken


class RefreshTokenError(Exception):
    """Refresh token rejected (revoked, expired, or unknown)."""


def _hash(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode()).hexdigest()


async def issue_refresh_token(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    agent_id: uuid.UUID,
    ttl_days: int,
) -> tuple[str, RefreshToken]:
    plaintext = secrets.token_urlsafe(32)
    record = RefreshToken(
        user_id=user_id,
        agent_id=agent_id,
        token_hash=_hash(plaintext),
        expires_at=datetime.now(UTC) + timedelta(days=ttl_days),
    )
    session.add(record)
    await session.flush()
    return plaintext, record


async def _find_active(session: AsyncSession, plaintext: str) -> RefreshToken:
    h = _hash(plaintext)
    rec = (
        await session.execute(
            select(RefreshToken).where(RefreshToken.token_hash == h)
        )
    ).scalar_one_or_none()
    if rec is None:
        raise RefreshTokenError("token invalid")
    if rec.revoked_at is not None:
        raise RefreshTokenError("token revoked")
    if rec.expires_at < datetime.now(UTC):
        raise RefreshTokenError("token expired")
    return rec


async def rotate_refresh_token(
    session: AsyncSession, *, plaintext: str
) -> tuple[str, RefreshToken]:
    old = await _find_active(session, plaintext)
    new_plaintext, new_record = await issue_refresh_token(
        session,
        user_id=old.user_id,
        agent_id=old.agent_id,
        ttl_days=max(1, int((old.expires_at - old.issued_at).days) or 90),
    )
    old.revoked_at = datetime.now(UTC)
    old.rotated_to_id = new_record.id
    await session.flush()
    return new_plaintext, new_record


async def revoke_refresh_token(session: AsyncSession, *, plaintext: str) -> None:
    rec = await _find_active(session, plaintext)
    rec.revoked_at = datetime.now(UTC)
    await session.flush()
