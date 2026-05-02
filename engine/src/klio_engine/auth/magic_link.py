"""Magic-link tokens. 15-min TTL, single-use, IP/UA recorded for audit."""
import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.refresh_token import MagicLinkToken


class MagicLinkError(Exception):
    """Magic link rejected (invalid, expired, consumed)."""


def _hash(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode()).hexdigest()


async def issue_magic_link(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    ttl_minutes: int,
    ip: str | None = None,
    user_agent: str | None = None,
) -> tuple[str, MagicLinkToken]:
    plaintext = secrets.token_urlsafe(32)
    record = MagicLinkToken(
        user_id=user_id,
        token_hash=_hash(plaintext),
        expires_at=datetime.now(UTC) + timedelta(minutes=ttl_minutes),
        requesting_ip=ip,
        requesting_user_agent=user_agent,
    )
    session.add(record)
    await session.flush()
    return plaintext, record


async def verify_magic_link(session: AsyncSession, *, plaintext: str) -> uuid.UUID:
    h = _hash(plaintext)
    rec = (
        await session.execute(
            select(MagicLinkToken).where(MagicLinkToken.token_hash == h)
        )
    ).scalar_one_or_none()
    if rec is None:
        raise MagicLinkError("token invalid")
    if rec.consumed_at is not None:
        raise MagicLinkError("token consumed")
    if rec.expires_at < datetime.now(UTC):
        raise MagicLinkError("token expired")
    rec.consumed_at = datetime.now(UTC)
    await session.flush()
    return rec.user_id
