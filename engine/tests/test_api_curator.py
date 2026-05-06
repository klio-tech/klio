"""POST /v1/curator/run-now — endpoint tests.

Drives the FastAPI app via `app.router.lifespan_context(app)` so the
curator's lifespan-attached scheduler / session_factory / kms get
provisioned, then issues the in-process HTTP request via
`httpx.AsyncClient(transport=ASGITransport(app=app))`.

httpx 0.28.x's ASGITransport does NOT dispatch lifespan messages, so
we run the lifespan explicitly. This is the same pattern used by
test_curator_provisioning.py.
"""
from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

import boto3
import pytest
from httpx import ASGITransport, AsyncClient
from moto import mock_aws
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from klio_engine.api.auth import _mint_for_test
from klio_engine.crypto.envelope import EnvelopeEncrypter
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.db import build_engine
from klio_engine.models.agent import Agent, AgentKind
from klio_engine.models.curator_state import CuratorState
from klio_engine.models.entry import Entry, EntryKind
from klio_engine.models.space import Space
from klio_engine.models.user import User
from klio_engine.services.user_keys import UserKeyService


pytestmark = pytest.mark.asyncio

JWT_SECRET = "test-secret-do-not-use-in-prod"
TEST_DB_URL = "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio"


@pytest.fixture(autouse=True)
def _hermetic_settings_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Settings the engine reads at boot."""
    monkeypatch.setenv("KLIO_DATABASE_URL", TEST_DB_URL)
    monkeypatch.setenv("KLIO_EMBEDDING_MODEL", "stub")
    monkeypatch.setenv("KLIO_EXTRACTION_MODEL", "stub")
    monkeypatch.setenv("KLIO_JWT_SIGNING_KEY", JWT_SECRET)
    # Default ON; individual tests flip it off as needed.
    monkeypatch.setenv("KLIO_CURATOR_ENABLED", "true")
    monkeypatch.setenv("KLIO_CURATOR_INTERVAL_SECS", "3600")

    # Reset module-level engine cache to avoid event-loop bleed across tests.
    import klio_engine.dependencies as deps

    deps._engine = None
    deps._factory = None
    yield
    deps._engine = None
    deps._factory = None


@pytest.fixture
def kms_override() -> Iterator[KMSClient]:
    """moto-backed KMS for the in-process app."""
    with mock_aws():
        boto = boto3.client("kms", region_name="us-east-1")
        arn = boto.create_key()["KeyMetadata"]["Arn"]
        yield KMSClient(key_arn=arn, region="us-east-1")


async def _seed_user_with_observations(
    *, kms: KMSClient, with_observations: bool
) -> tuple[uuid.UUID, uuid.UUID]:
    """Seed a User (with envelope key), default Space, an Agent, and
    optionally a batch of encrypted observations. Returns
    (user_id, agent_id).

    Uses a one-off engine + sessionmaker bound to the test DB so the
    seed commits before the in-process app's request is dispatched.
    """
    engine = build_engine(TEST_DB_URL)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with factory() as session:
            user = User(id=uuid.uuid4())
            session.add(user)
            await session.flush()

            plaintext_key = await UserKeyService(kms).provision_user_key(
                session, user
            )
            envelope = EnvelopeEncrypter(envelope_key=plaintext_key)

            space = Space(
                id=uuid.uuid4(),
                user_id=user.id,
                name="Default",
                slug="default",
                embedding_model="stub",
                embedding_dim=1536,
            )
            session.add(space)

            agent = Agent(
                id=uuid.uuid4(),
                user_id=user.id,
                display_name="Test agent",
                kind=AgentKind.CLAUDE_CODE,
                install_id=uuid.uuid4(),
            )
            session.add(agent)
            await session.flush()

            if with_observations:
                base = datetime.now(timezone.utc) - timedelta(hours=1)
                contents = [
                    "user prefers Bun runtime over Node",
                    "we'll use Railway for hosting, not Fly.io",
                    "decided to deploy via GitHub Actions on every PR merge",
                    "user said remember the npm package is @klio-tech/klio",
                ]
                for i, content in enumerate(contents):
                    nonce, ct = envelope.encrypt(content.encode("utf-8"))
                    session.add(
                        Entry(
                            id=uuid.uuid4(),
                            user_id=user.id,
                            space_id=space.id,
                            agent_id=agent.id,
                            kind=EntryKind.OBSERVATION,
                            content_nonce=nonce,
                            content_ciphertext=ct,
                            created_at=base + timedelta(minutes=i),
                        )
                    )
            await session.commit()
            return user.id, agent.id
    finally:
        await engine.dispose()


async def _read_curator_state(user_id: uuid.UUID) -> CuratorState | None:
    engine = build_engine(TEST_DB_URL)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with factory() as session:
            return (
                await session.execute(
                    select(CuratorState).where(
                        CuratorState.user_id == user_id
                    )
                )
            ).scalar_one_or_none()
    finally:
        await engine.dispose()


async def _delete_user(user_id: uuid.UUID) -> None:
    """Best-effort cleanup so repeated test runs don't pile up state."""
    engine = build_engine(TEST_DB_URL)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with factory() as session:
            user = await session.get(User, user_id)
            if user is not None:
                await session.delete(user)
                await session.commit()
    finally:
        await engine.dispose()


async def test_run_now_disabled_returns_503(
    monkeypatch: pytest.MonkeyPatch, kms_override: KMSClient
) -> None:
    """When KLIO_CURATOR_ENABLED=false, the endpoint refuses with 503."""
    monkeypatch.setenv("KLIO_CURATOR_ENABLED", "false")
    from klio_engine.api.main import build_app
    from klio_engine.dependencies import get_kms

    user_id, agent_id = await _seed_user_with_observations(
        kms=kms_override, with_observations=False
    )
    try:
        app = build_app()
        app.dependency_overrides[get_kms] = lambda: kms_override
        token = _mint_for_test(
            JWT_SECRET, user_id, agent_id, ["read", "write"], ttl=3600
        )
        async with app.router.lifespan_context(app):
            async with AsyncClient(
                transport=ASGITransport(app=app),
                base_url="http://test",
            ) as client:
                resp = await client.post(
                    "/v1/curator/run-now",
                    headers={"Authorization": f"Bearer {token}"},
                )
        assert resp.status_code == 503, resp.text
        assert "disabled" in resp.json()["detail"].lower()
    finally:
        await _delete_user(user_id)


async def test_run_now_unauthenticated_returns_401(
    kms_override: KMSClient,
) -> None:
    """No bearer token → 401 from `require_auth`."""
    from klio_engine.api.main import build_app
    from klio_engine.dependencies import get_kms

    app = build_app()
    app.dependency_overrides[get_kms] = lambda: kms_override
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post("/v1/curator/run-now")
    assert resp.status_code == 401, resp.text


async def test_run_now_authenticated_runs_and_returns_state(
    kms_override: KMSClient,
) -> None:
    """Provision a user, seed observations, hit the endpoint, assert
    the response carries `synthesized > 0`, a valid ISO timestamp for
    `cursor_advanced_to`, and `error: null`."""
    from klio_engine.api.main import build_app
    from klio_engine.dependencies import get_kms

    user_id, agent_id = await _seed_user_with_observations(
        kms=kms_override, with_observations=True
    )
    try:
        app = build_app()
        app.dependency_overrides[get_kms] = lambda: kms_override
        token = _mint_for_test(
            JWT_SECRET, user_id, agent_id, ["read", "write"], ttl=3600
        )
        async with app.router.lifespan_context(app):
            async with AsyncClient(
                transport=ASGITransport(app=app),
                base_url="http://test",
            ) as client:
                resp = await client.post(
                    "/v1/curator/run-now",
                    headers={"Authorization": f"Bearer {token}"},
                )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["synthesized"] > 0, body
        # cursor_advanced_to must round-trip through fromisoformat.
        assert body["cursor_advanced_to"] is not None
        parsed = datetime.fromisoformat(body["cursor_advanced_to"])
        assert parsed.tzinfo is not None
        assert body["error"] is None
        assert body["skipped_concurrent"] is False

        # Per-user curator_state row should now exist with matching values.
        state = await _read_curator_state(user_id)
        assert state is not None
        assert state.last_synthesized == body["synthesized"]
        assert state.last_error is None
    finally:
        await _delete_user(user_id)


async def test_run_now_idempotent_when_no_observations(
    kms_override: KMSClient,
) -> None:
    """Empty backlog → response has `synthesized: 0`, `error: null`,
    `skipped_concurrent: false`. The cursor stays at the epoch
    (it's a clean no-op tick)."""
    from klio_engine.api.main import build_app
    from klio_engine.dependencies import get_kms

    user_id, agent_id = await _seed_user_with_observations(
        kms=kms_override, with_observations=False
    )
    try:
        app = build_app()
        app.dependency_overrides[get_kms] = lambda: kms_override
        token = _mint_for_test(
            JWT_SECRET, user_id, agent_id, ["read", "write"], ttl=3600
        )
        async with app.router.lifespan_context(app):
            async with AsyncClient(
                transport=ASGITransport(app=app),
                base_url="http://test",
            ) as client:
                resp = await client.post(
                    "/v1/curator/run-now",
                    headers={"Authorization": f"Bearer {token}"},
                )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["synthesized"] == 0
        assert body["error"] is None
        assert body["skipped_concurrent"] is False
        # cursor_advanced_to is the epoch (no observations to advance past).
        assert body["cursor_advanced_to"] is not None
    finally:
        await _delete_user(user_id)
