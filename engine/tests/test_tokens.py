"""JWT mint/verify tests."""
import time
import uuid

import pytest

from klio_engine.auth.tokens import (
    TokenError,
    mint_access_token,
    verify_access_token,
)


def test_round_trip() -> None:
    user_id = uuid.uuid4()
    agent_id = uuid.uuid4()
    secret = "test-secret"
    token = mint_access_token(
        secret=secret,
        user_id=user_id,
        agent_id=agent_id,
        scopes=["read", "write"],
        ttl_seconds=60,
    )
    claims = verify_access_token(secret=secret, token=token)
    assert claims["sub"] == str(user_id)
    assert claims["agent_id"] == str(agent_id)
    assert claims["scopes"] == ["read", "write"]


def test_expired_rejected() -> None:
    secret = "k"
    token = mint_access_token(
        secret=secret,
        user_id=uuid.uuid4(),
        agent_id=uuid.uuid4(),
        scopes=[],
        ttl_seconds=1,
    )
    time.sleep(2)
    with pytest.raises(TokenError, match="expired"):
        verify_access_token(secret=secret, token=token)


def test_wrong_secret_rejected() -> None:
    token = mint_access_token(
        secret="key1",
        user_id=uuid.uuid4(),
        agent_id=uuid.uuid4(),
        scopes=[],
        ttl_seconds=60,
    )
    with pytest.raises(TokenError, match="signature"):
        verify_access_token(secret="key2", token=token)


def test_tampered_rejected() -> None:
    secret = "k"
    token = mint_access_token(
        secret=secret,
        user_id=uuid.uuid4(),
        agent_id=uuid.uuid4(),
        scopes=[],
        ttl_seconds=60,
    )
    parts = token.split(".")
    parts[1] = parts[1][:-1] + "X"
    tampered = ".".join(parts)
    with pytest.raises(TokenError):
        verify_access_token(secret=secret, token=tampered)
