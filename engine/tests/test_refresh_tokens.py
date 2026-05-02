"""Refresh-token lifecycle tests."""
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.auth.refresh import (
    RefreshTokenError,
    issue_refresh_token,
    revoke_refresh_token,
    rotate_refresh_token,
)


@pytest.mark.asyncio
async def test_issue_creates_persisted(session: AsyncSession) -> None:
    user_id = uuid.uuid4()
    agent_id = uuid.uuid4()
    plaintext, record = await issue_refresh_token(
        session, user_id=user_id, agent_id=agent_id, ttl_days=90
    )
    assert isinstance(plaintext, str)
    assert len(plaintext) >= 32
    assert record.user_id == user_id
    assert record.agent_id == agent_id
    assert record.revoked_at is None


@pytest.mark.asyncio
async def test_rotate_invalidates_old(session: AsyncSession) -> None:
    old_pt, _ = await issue_refresh_token(
        session, user_id=uuid.uuid4(), agent_id=uuid.uuid4(), ttl_days=90
    )
    new_pt, new_rec = await rotate_refresh_token(session, plaintext=old_pt)
    assert new_pt != old_pt
    assert new_rec.revoked_at is None

    with pytest.raises(RefreshTokenError, match="revoked|invalid"):
        await rotate_refresh_token(session, plaintext=old_pt)


@pytest.mark.asyncio
async def test_revoke_marks_revoked(session: AsyncSession) -> None:
    pt, _ = await issue_refresh_token(
        session, user_id=uuid.uuid4(), agent_id=uuid.uuid4(), ttl_days=90
    )
    await revoke_refresh_token(session, plaintext=pt)
    with pytest.raises(RefreshTokenError, match="revoked"):
        await rotate_refresh_token(session, plaintext=pt)


@pytest.mark.asyncio
async def test_invalid_token_rejected(session: AsyncSession) -> None:
    with pytest.raises(RefreshTokenError, match="invalid"):
        await rotate_refresh_token(session, plaintext="not-a-real-token")
