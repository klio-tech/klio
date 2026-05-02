"""Tests for /v1/auth/login-link.

This endpoint must:
  1. Return 200 with ok=True for ANY email (don't leak which are registered).
  2. Issue a magic-link only when the email matches an existing claimed user.
  3. Set claimed_at if the user existed and was anonymous (no — we don't
     auto-claim on login-link; that's reserved for /verify).
"""
from __future__ import annotations

import hashlib
import uuid
from collections.abc import Iterator

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from klio_engine.api.main import build_app
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.dependencies import get_kms
from klio_engine.models.refresh_token import MagicLinkToken
from klio_engine.models.user import User

JWT_SECRET = "test-secret-do-not-use-in-prod"


@pytest.fixture
def api_client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv(
        "KLIO_DATABASE_URL",
        "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio",
    )
    monkeypatch.setenv("KLIO_JWT_SIGNING_KEY", JWT_SECRET)
    monkeypatch.setenv("KLIO_EMBEDDING_MODEL", "stub")

    import klio_engine.dependencies as deps

    deps._engine = None
    deps._factory = None

    with mock_aws():
        kms_low = boto3.client("kms", region_name="us-east-1")
        arn = kms_low.create_key()["KeyMetadata"]["Arn"]
        kms = KMSClient(key_arn=arn, region="us-east-1")

        app = build_app()
        app.dependency_overrides[get_kms] = lambda: kms
        with TestClient(app) as client:
            yield client

    deps._engine = None
    deps._factory = None


def test_login_link_unknown_email_returns_ok(api_client: TestClient) -> None:
    """Unknown emails MUST return ok=True (no leak)."""
    r = api_client.post(
        "/v1/auth/login-link",
        json={"email": "no-such-user-yet@example.com"},
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_login_link_invalid_email_422(api_client: TestClient) -> None:
    r = api_client.post("/v1/auth/login-link", json={"email": "not-an-email"})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_login_link_issues_token_for_known_user(
    api_client: TestClient,
) -> None:
    """When the email maps to a user, a magic-link row gets persisted."""
    # Unique email per run so we don't collide with rows from prior test runs.
    email = f"loginlink-test-{uuid.uuid4().hex[:12]}@example.com"

    prov = api_client.post(
        "/v1/users/provision",
        json={
            "agent_kind": "claude-code",
            "install_id": str(uuid.uuid4()),
            "email": email,
        },
    ).json()
    user_id = uuid.UUID(prov["user_id"])

    before_count = await _count_magic_links(user_id)

    r = api_client.post("/v1/auth/login-link", json={"email": email})
    assert r.status_code == 200

    after_count = await _count_magic_links(user_id)
    assert after_count == before_count + 1


async def _count_magic_links(user_id: uuid.UUID) -> int:
    engine = create_async_engine(
        "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio"
    )
    try:
        Session = async_sessionmaker(engine, expire_on_commit=False)
        async with Session() as s:
            rows = (
                await s.execute(
                    select(MagicLinkToken).where(MagicLinkToken.user_id == user_id)
                )
            ).scalars().all()
            return len(rows)
    finally:
        await engine.dispose()
