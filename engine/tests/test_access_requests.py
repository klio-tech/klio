"""End-to-end access request flow tests."""
from __future__ import annotations

import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass

import boto3
import pytest
from fastapi.testclient import TestClient
from jose import jwt as _jwt
from moto import mock_aws

from klio_engine.api.auth import _mint_for_test
from klio_engine.api.main import build_app
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.dependencies import get_kms

JWT_SECRET = "test-secret-do-not-use-in-prod"


@dataclass
class Ctx:
    user_id: uuid.UUID
    agent_id: uuid.UUID
    default_space_id: uuid.UUID
    agent_token: str
    session_token: str

    def agent_header(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.agent_token}"}

    def session_header(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.session_token}"}


def _mint_session_token(user_id: uuid.UUID) -> str:
    """A session-scoped token (the trust app uses these for approve/deny)."""
    now = int(time.time())
    payload = {
        "sub": str(user_id),
        "agent_id": str(user_id),
        "scopes": ["session"],
        "iat": now,
        "exp": now + 3600,
        "aud": "klio.tech",
        "iss": "test",
    }
    return _jwt.encode(payload, JWT_SECRET, algorithm="HS256")


@pytest.fixture
def app_client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv(
        "KLIO_DATABASE_URL",
        "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio",
    )
    monkeypatch.setenv("KLIO_JWT_SIGNING_KEY", JWT_SECRET)
    monkeypatch.setenv("KLIO_EMBEDDING_MODEL", "stub")
    monkeypatch.setenv("KLIO_EXTRACTION_MODEL", "stub")

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


def _provision(client: TestClient) -> Ctx:
    body = {"agent_kind": "claude-code", "install_id": str(uuid.uuid4())}
    p = client.post("/v1/users/provision", json=body).json()
    user_id = uuid.UUID(p["user_id"])
    agent_id = uuid.UUID(p["agent_id"])
    return Ctx(
        user_id=user_id,
        agent_id=agent_id,
        default_space_id=uuid.UUID(p["default_space_id"]),
        agent_token=_mint_for_test(
            JWT_SECRET, user_id, agent_id, ["read", "write", "admin"], ttl=3600
        ),
        session_token=_mint_session_token(user_id),
    )


def _new_agent(client: TestClient, ctx: Ctx, kind: str = "cursor") -> uuid.UUID:
    body = {
        "user_id": str(ctx.user_id),
        "kind": kind,
        "install_id": str(uuid.uuid4()),
    }
    # The internal endpoint isn't public — but the test app constructs
    # one via direct DB call. For simplicity, create via the full provision
    # flow (it makes a separate user). Here we use a different approach:
    # create via the engine's internal seam isn't exposed, so we create a
    # second user instead and use their agent_id. But that user has its own
    # spaces, so we can't use it for cross-agent ACL on ctx's space.
    #
    # Cleanest: use a small internal helper directly via the test database.
    raise NotImplementedError("see _make_second_agent_for_user instead")


def _make_second_agent_for_user(ctx: Ctx) -> uuid.UUID:
    """Insert a second agent under the same user. Uses direct DB access."""
    import asyncio

    from sqlalchemy import insert
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from klio_engine.models.agent import Agent, AgentKind

    async def _go() -> uuid.UUID:
        engine = create_async_engine(
            "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio"
        )
        try:
            Session = async_sessionmaker(engine, expire_on_commit=False)
            async with Session() as s:
                agent_id = uuid.uuid4()
                stmt = insert(Agent).values(
                    id=agent_id,
                    user_id=ctx.user_id,
                    kind=AgentKind.CURSOR,
                    install_id=uuid.uuid4(),
                )
                await s.execute(stmt)
                await s.commit()
                return agent_id
        finally:
            await engine.dispose()

    return asyncio.run(_go())


def test_create_request_then_approve_grants_permission(
    app_client: TestClient,
) -> None:
    ctx = _provision(app_client)

    # Build a second agent and an agent-token for it.
    second_agent_id = _make_second_agent_for_user(ctx)
    second_token = _mint_for_test(
        JWT_SECRET, ctx.user_id, second_agent_id, ["read"], ttl=3600
    )

    # Second agent requests read access to the default space.
    body = {"space_slug": "default", "requested_scope": "read", "reason": "Demo"}
    r = app_client.post(
        f"/v1/agents/{second_agent_id}/request-access",
        json=body,
        headers={"Authorization": f"Bearer {second_token}"},
    )
    assert r.status_code == 201, r.text
    req = r.json()
    assert req["status"] == "pending"

    # User lists pending — should see one
    listed = app_client.get("/v1/access-requests", headers=ctx.session_header())
    assert listed.status_code == 200
    rows = listed.json()
    assert any(row["id"] == req["id"] for row in rows)

    # User approves
    r = app_client.post(
        f"/v1/access-requests/{req['id']}/approve",
        json={},
        headers=ctx.session_header(),
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved"

    # The second agent should now be able to recall in the default space
    second_with_session = _mint_for_test(
        JWT_SECRET, ctx.user_id, second_agent_id, ["read"], ttl=3600
    )
    rec = app_client.post(
        f"/v1/spaces/{ctx.default_space_id}/recall",
        json={"query": "anything"},
        headers={"Authorization": f"Bearer {second_with_session}"},
    )
    # 200 because the new permission row exists; even if there are no
    # entries to return, 200 with [] is correct.
    assert rec.status_code == 200, rec.text


def test_create_request_then_deny_does_not_grant(app_client: TestClient) -> None:
    ctx = _provision(app_client)
    second_agent_id = _make_second_agent_for_user(ctx)
    second_token = _mint_for_test(
        JWT_SECRET, ctx.user_id, second_agent_id, ["read"], ttl=3600
    )

    body = {"space_slug": "default", "requested_scope": "write"}
    r = app_client.post(
        f"/v1/agents/{second_agent_id}/request-access",
        json=body,
        headers={"Authorization": f"Bearer {second_token}"},
    )
    request_id = r.json()["id"]

    r = app_client.post(
        f"/v1/access-requests/{request_id}/deny", headers=ctx.session_header()
    )
    assert r.status_code == 200
    assert r.json()["status"] == "denied"

    # Second agent still cannot read
    rec = app_client.post(
        f"/v1/spaces/{ctx.default_space_id}/recall",
        json={"query": "x"},
        headers={"Authorization": f"Bearer {second_token}"},
    )
    assert rec.status_code == 403


def test_request_with_unknown_space_404(app_client: TestClient) -> None:
    ctx = _provision(app_client)
    body = {"space_slug": "no-such-slug", "requested_scope": "read"}
    r = app_client.post(
        f"/v1/agents/{ctx.agent_id}/request-access",
        json=body,
        headers=ctx.agent_header(),
    )
    assert r.status_code == 404


def test_request_existing_scope_409(app_client: TestClient) -> None:
    """If the agent already has the requested scope, the engine refuses
    to create a new pending request (would be a no-op spam)."""
    ctx = _provision(app_client)
    body = {"space_slug": "default", "requested_scope": "read"}
    r = app_client.post(
        f"/v1/agents/{ctx.agent_id}/request-access",
        json=body,
        headers=ctx.agent_header(),
    )
    # The provisioning agent has admin on default — admin >= read.
    assert r.status_code == 409


def test_approve_requires_session_token(app_client: TestClient) -> None:
    """A standard agent token cannot approve — must be a session token."""
    ctx = _provision(app_client)
    second_agent_id = _make_second_agent_for_user(ctx)
    second_token = _mint_for_test(
        JWT_SECRET, ctx.user_id, second_agent_id, ["read"], ttl=3600
    )

    body = {"space_slug": "default", "requested_scope": "read"}
    r = app_client.post(
        f"/v1/agents/{second_agent_id}/request-access",
        json=body,
        headers={"Authorization": f"Bearer {second_token}"},
    )
    request_id = r.json()["id"]

    # Try to approve with the agent token — must be 403.
    r = app_client.post(
        f"/v1/access-requests/{request_id}/approve",
        json={},
        headers=ctx.agent_header(),  # not session-scoped
    )
    assert r.status_code == 403


def test_request_with_mismatched_agent_token_403(app_client: TestClient) -> None:
    """The agent_id in the URL MUST match the auth token's agent_id."""
    ctx_a = _provision(app_client)
    ctx_b = _provision(app_client)

    body = {"space_slug": "default", "requested_scope": "read"}
    r = app_client.post(
        f"/v1/agents/{ctx_a.agent_id}/request-access",
        json=body,
        headers=ctx_b.agent_header(),  # B's token vs A's agent_id
    )
    assert r.status_code == 403
