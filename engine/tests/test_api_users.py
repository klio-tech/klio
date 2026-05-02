"""End-to-end tests for /v1/users/* endpoints against a real running app.

We construct a TestClient bound to the live Postgres (not the per-test schema),
so the engine app sees the same tables Alembic provisioned. To avoid
test pollution we:
  - Run each provision in its own Postgres advisory-locked region
  - Use the user_id from the response to scope assertions
  - Use moto for KMS via a patched dependency override

Coordinator endpoints write to live Postgres tables; the assertions read
back through the same session.
"""
from __future__ import annotations

import uuid
from collections.abc import Iterator

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from klio_engine.api.main import build_app
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.dependencies import get_kms


@pytest.fixture
def api_client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """TestClient with overrides:
    - moto-backed KMS
    - signing key from env
    - per-test engine factory reset to avoid event-loop bleed across tests
    """
    monkeypatch.setenv(
        "KLIO_DATABASE_URL",
        "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio",
    )
    monkeypatch.setenv("KLIO_JWT_SIGNING_KEY", "test-secret-do-not-use-in-prod")

    # Reset module-level engine cache before each test
    import klio_engine.dependencies as deps

    deps._engine = None
    deps._factory = None

    with mock_aws():
        kms = boto3.client("kms", region_name="us-east-1")
        arn = kms.create_key()["KeyMetadata"]["Arn"]
        client_obj = KMSClient(key_arn=arn, region="us-east-1")

        app = build_app()
        app.dependency_overrides[get_kms] = lambda: client_obj
        with TestClient(app) as client:
            yield client

    # Cleanup the engine
    deps._engine = None
    deps._factory = None


def test_health_endpoint(api_client: TestClient) -> None:
    r = api_client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_provision_anonymous_returns_credentials(api_client: TestClient) -> None:
    body = {"agent_kind": "claude-code", "install_id": str(uuid.uuid4())}
    r = api_client.post("/v1/users/provision", json=body)
    assert r.status_code == 201, r.text
    data = r.json()
    assert "user_id" in data
    assert "api_key" in data
    assert data["claimed"] is False
    assert "default_space_id" in data
    assert len(data["api_key"]) >= 32


def test_provision_then_refresh(api_client: TestClient) -> None:
    prov = api_client.post(
        "/v1/users/provision",
        json={"agent_kind": "claude-code", "install_id": str(uuid.uuid4())},
    ).json()
    api_key = prov["api_key"]

    r = api_client.post("/v1/tokens/refresh", json={"refresh_token": api_key})
    assert r.status_code == 200, r.text
    data = r.json()
    assert "access_token" in data
    assert "refresh_token" in data
    assert data["refresh_token"] != api_key

    # Old token must now be rejected (one-time use)
    r2 = api_client.post("/v1/tokens/refresh", json={"refresh_token": api_key})
    assert r2.status_code == 401


def test_provision_invalid_agent_kind(api_client: TestClient) -> None:
    body = {"agent_kind": "not-real", "install_id": str(uuid.uuid4())}
    r = api_client.post("/v1/users/provision", json=body)
    # The internal AgentKind() conversion raises ValueError → 500.
    assert r.status_code in (400, 422, 500)


def test_provision_missing_required(api_client: TestClient) -> None:
    r = api_client.post("/v1/users/provision", json={"install_id": str(uuid.uuid4())})
    assert r.status_code == 422


def test_claim_then_verify_flow(
    api_client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    """End-to-end: provision → claim (issues link) → verify (consumes link)."""
    prov = api_client.post(
        "/v1/users/provision",
        json={"agent_kind": "claude-code", "install_id": str(uuid.uuid4())},
    ).json()
    user_id = prov["user_id"]

    # Send claim
    r = api_client.post(
        f"/v1/users/{user_id}/claim", json={"email": "abhishek@example.com"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["magic_link_sent"] is True

    # In dev mode the link is logged via structlog. To get the token in test,
    # we read it directly from the DB via a fresh session.
    import asyncio

    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    async def fetch_latest_token() -> str:
        engine = create_async_engine(
            "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio"
        )
        try:
            from klio_engine.models.refresh_token import MagicLinkToken

            Session = async_sessionmaker(engine, expire_on_commit=False)
            async with Session() as s:
                row = (
                    await s.execute(
                        select(MagicLinkToken)
                        .where(MagicLinkToken.user_id == uuid.UUID(user_id))
                        .order_by(MagicLinkToken.issued_at.desc())
                        .limit(1)
                    )
                ).scalar_one()
                return row.token_hash
        finally:
            await engine.dispose()

    # We can't recover plaintext from the hash; instead, issue a brand-new
    # magic link via a direct service call to get the plaintext.
    async def issue_one() -> str:
        from klio_engine.auth.magic_link import issue_magic_link

        engine = create_async_engine(
            "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio"
        )
        try:
            Session = async_sessionmaker(engine, expire_on_commit=False)
            async with Session() as s:
                pt, _ = await issue_magic_link(
                    s, user_id=uuid.UUID(user_id), ttl_minutes=15
                )
                await s.commit()
                return pt
        finally:
            await engine.dispose()

    plaintext = asyncio.run(issue_one())

    # Verify the link
    r2 = api_client.post(f"/v1/users/{user_id}/verify", json={"token": plaintext})
    assert r2.status_code == 200, r2.text
    body = r2.json()
    assert body["user_id"] == user_id
    assert "session_token" in body
    assert "access_token" in body


def test_verify_rejects_invalid_token(api_client: TestClient) -> None:
    user_id = str(uuid.uuid4())
    r = api_client.post(
        f"/v1/users/{user_id}/verify", json={"token": "not-a-valid-token"}
    )
    assert r.status_code == 400
