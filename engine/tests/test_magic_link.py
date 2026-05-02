"""Magic link tests."""
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.auth.magic_link import (
    MagicLinkError,
    issue_magic_link,
    verify_magic_link,
)


@pytest.mark.asyncio
async def test_issue_returns_token_and_persists(session: AsyncSession) -> None:
    user_id = uuid.uuid4()
    plaintext, record = await issue_magic_link(
        session, user_id=user_id, ttl_minutes=15, ip="1.2.3.4", user_agent="curl/8"
    )
    assert len(plaintext) >= 32
    assert record.user_id == user_id
    assert record.consumed_at is None


@pytest.mark.asyncio
async def test_verify_consumes_token(session: AsyncSession) -> None:
    user_id = uuid.uuid4()
    pt, _ = await issue_magic_link(session, user_id=user_id, ttl_minutes=15)
    consumed = await verify_magic_link(session, plaintext=pt)
    assert consumed == user_id

    with pytest.raises(MagicLinkError, match="consumed|invalid"):
        await verify_magic_link(session, plaintext=pt)


@pytest.mark.asyncio
async def test_expired_rejected(session: AsyncSession) -> None:
    user_id = uuid.uuid4()
    pt, rec = await issue_magic_link(session, user_id=user_id, ttl_minutes=15)
    rec.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await session.flush()
    with pytest.raises(MagicLinkError, match="expired"):
        await verify_magic_link(session, plaintext=pt)


@pytest.mark.asyncio
async def test_unknown_token_rejected(session: AsyncSession) -> None:
    with pytest.raises(MagicLinkError, match="invalid"):
        await verify_magic_link(session, plaintext="never-issued-token-xyz")
