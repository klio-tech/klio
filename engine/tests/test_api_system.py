"""Tests for /v1/system/* endpoints.

Today: just `GET /v1/system/banners`. Future kinds (update_available,
update_failed) will be added as their producers land — see the
companion design doc.

Mirrors the lifespan/ASGITransport pattern from
`test_api_curator.py` and `test_curator_provisioning.py`. We hit the
in-process FastAPI app via `httpx.AsyncClient` + `ASGITransport`, and
drive the lifespan explicitly through `app.router.lifespan_context(app)`
because httpx 0.28's ASGITransport doesn't dispatch lifespan messages.

Seeding happens through a one-off engine bound to the same dev test
DB (port 5433) used by the rest of the engine test suite. We only
need a `User` row — no envelope key, no Space, no Agent — because
the banners endpoint reads exactly one column (`users.claimed_at`)
and the JWT's `agent_id` claim is opaque to it (no DB lookup on the
agent).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker

from klio_engine.api.auth import _mint_for_test
from klio_engine.db import build_engine
from klio_engine.models.user import User


pytestmark = pytest.mark.asyncio

JWT_SECRET = "test-secret-do-not-use-in-prod"
TEST_DB_URL = "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio"


@pytest.fixture(autouse=True)
def _hermetic_settings_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Standard hermetic-settings fixture matching the rest of the
    api-level test suite. Required env for `Settings()` construction
    inside the lifespan, plus the JWT signing key the auth dependency
    consults."""
    monkeypatch.setenv("KLIO_DATABASE_URL", TEST_DB_URL)
    monkeypatch.setenv("KLIO_EMBEDDING_MODEL", "stub")
    monkeypatch.setenv("KLIO_EXTRACTION_MODEL", "stub")
    monkeypatch.setenv("KLIO_JWT_SIGNING_KEY", JWT_SECRET)
    # Curator off — banners endpoint is independent of curator state
    # and we don't want a scheduler thread fighting the test loop.
    monkeypatch.setenv("KLIO_CURATOR_ENABLED", "false")

    # Reset the module-level engine cache so each test gets a fresh
    # async engine bound to its own loop. Mirrors test_api_curator.py.
    import klio_engine.dependencies as deps

    deps._engine = None
    deps._factory = None
    yield
    deps._engine = None
    deps._factory = None


async def _seed_user(*, claimed: bool) -> uuid.UUID:
    """Insert a `User` row and return its id. `claimed=True` sets
    `claimed_at` to now-UTC; `claimed=False` leaves it NULL (the
    anonymous-account default).

    A one-off engine + sessionmaker is used so the seed commits before
    the in-process app dispatches the request — same pattern as the
    curator endpoint tests.
    """
    engine = build_engine(TEST_DB_URL)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with factory() as session:
            user = User(id=uuid.uuid4())
            if claimed:
                user.claimed_at = datetime.now(timezone.utc)
            session.add(user)
            await session.commit()
            return user.id
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


async def test_banners_unauth_returns_401() -> None:
    """No bearer token → 401 from `require_auth`."""
    from klio_engine.api.main import build_app

    app = build_app()
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/v1/system/banners")
    assert resp.status_code == 401, resp.text


async def test_banners_for_unclaimed_user_returns_claim_email() -> None:
    """Unclaimed user (`claimed_at IS NULL`) → response banners list
    contains exactly the `claim_email` banner with the expected shape
    (kind, severity, title, body, action.form.endpoint+fields)."""
    from klio_engine.api.main import build_app

    user_id = await _seed_user(claimed=False)
    try:
        app = build_app()
        token = _mint_for_test(
            JWT_SECRET, user_id, uuid.uuid4(), ["read", "write"], ttl=3600
        )
        async with app.router.lifespan_context(app):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.get(
                    "/v1/system/banners",
                    headers={"Authorization": f"Bearer {token}"},
                )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert "banners" in body, body
        kinds = [b["kind"] for b in body["banners"]]
        assert "claim_email" in kinds, body
        claim = next(b for b in body["banners"] if b["kind"] == "claim_email")
        assert claim["severity"] == "info"
        assert isinstance(claim["title"], str) and claim["title"]
        assert isinstance(claim["body"], str) and claim["body"]
        action = claim["action"]
        assert action["form"]["endpoint"] == "/v1/auth/login-link"
        assert action["form"]["fields"] == ["email"]
    finally:
        await _delete_user(user_id)


async def test_banners_for_claimed_user_returns_empty() -> None:
    """Claimed user (`claimed_at IS NOT NULL`) → no `claim_email`
    banner. v0.6.0 ships only `claim_email`, so the list is empty;
    when future kinds land they'll have their own tests and this one
    stays scoped to "no claim_email for claimed users"."""
    from klio_engine.api.main import build_app

    user_id = await _seed_user(claimed=True)
    try:
        app = build_app()
        token = _mint_for_test(
            JWT_SECRET, user_id, uuid.uuid4(), ["read", "write"], ttl=3600
        )
        async with app.router.lifespan_context(app):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.get(
                    "/v1/system/banners",
                    headers={"Authorization": f"Bearer {token}"},
                )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert "banners" in body, body
        kinds = [b["kind"] for b in body["banners"]]
        assert "claim_email" not in kinds, body
        # v0.6.0 ships only claim_email. Future kinds will relax this.
        assert body["banners"] == [], body
    finally:
        await _delete_user(user_id)
