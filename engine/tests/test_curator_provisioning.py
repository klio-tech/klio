"""Curator: per-user job registration on provisioning.

When a new user is provisioned mid-uptime, the curator must
register a job for that user immediately — without restarting
the engine. This test drives the FastAPI app's lifespan + a
single provisioning request, and asserts the scheduler now has
a job whose id matches the freshly-created user_id.

Driving the lifespan via `app.router.lifespan_context(app)`
mirrors `test_curator_lifespan.py` — httpx 0.28.x's ASGITransport
does NOT dispatch lifespan messages, so we run the lifespan
explicitly and only use ASGITransport for the in-process HTTP
request that exercises the provisioning route.
"""
from __future__ import annotations

import uuid
from collections.abc import Iterator

import boto3
import pytest
from httpx import ASGITransport, AsyncClient
from moto import mock_aws

from klio_engine.crypto.kms_client import KMSClient


pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _hermetic_settings_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Settings the engine reads at boot. Mirrors the env in
    `test_curator_lifespan.py` and adds the curator-on flags so
    the lifespan registers the scheduler + state we assert on.
    """
    monkeypatch.setenv(
        "KLIO_DATABASE_URL",
        "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio",
    )
    monkeypatch.setenv("KLIO_EMBEDDING_MODEL", "stub")
    monkeypatch.setenv("KLIO_EXTRACTION_MODEL", "stub")
    monkeypatch.setenv("KLIO_CURATOR_ENABLED", "true")
    monkeypatch.setenv("KLIO_CURATOR_INTERVAL_SECS", "3600")
    monkeypatch.setenv("KLIO_JWT_SIGNING_KEY", "test-secret-do-not-use-in-prod")

    # Reset the module-level engine cache shared by `dependencies.get_session`.
    # Without this, a stale AsyncEngine bound to a closed event loop from a
    # previous test bleeds into this one and the provisioning insert fails.
    import klio_engine.dependencies as deps

    deps._engine = None
    deps._factory = None
    yield
    deps._engine = None
    deps._factory = None


@pytest.fixture
def kms_override() -> Iterator[KMSClient]:
    """moto-backed KMS for the in-process app. The lifespan creates
    its own KMS for the curator path; this override only affects
    `get_kms` (the request-scoped dependency used by the provisioning
    route)."""
    with mock_aws():
        boto = boto3.client("kms", region_name="us-east-1")
        arn = boto.create_key()["KeyMetadata"]["Arn"]
        yield KMSClient(key_arn=arn, region="us-east-1")


async def test_provision_registers_curator_job(kms_override: KMSClient) -> None:
    """End-to-end: drive the FastAPI lifespan, hit
    POST /v1/users/provision, assert a curator job exists
    keyed by the new user's id."""
    from klio_engine.api.main import build_app
    from klio_engine.dependencies import get_kms

    app = build_app()
    app.dependency_overrides[get_kms] = lambda: kms_override

    async with app.router.lifespan_context(app):
        scheduler = app.state.curator_scheduler
        before_jobs = {j.id for j in scheduler.get_jobs()}

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            body = {
                "agent_kind": "claude-code",
                "install_id": str(uuid.uuid4()),
            }
            resp = await client.post("/v1/users/provision", json=body)
            assert resp.status_code in (200, 201), resp.text
            user_id = resp.json()["user_id"]

        after_jobs = {j.id for j in scheduler.get_jobs()}
        new_jobs = after_jobs - before_jobs
        assert any(user_id in j for j in new_jobs), (
            f"expected a curator job containing user_id={user_id}, "
            f"got new jobs: {new_jobs}"
        )


async def test_register_user_job_is_idempotent(kms_override: KMSClient) -> None:
    """`register_user_job` is contract-documented as idempotent. A
    pathological double-call (e.g., the route handler executes the
    helper twice for the same user_id under some race) must not
    cause double-registration in the scheduler. Verify by calling
    the helper twice for the same user_id and asserting the job set
    is unchanged."""
    from klio_engine.api.main import build_app
    from klio_engine.config import Settings
    from klio_engine.dependencies import get_kms
    from klio_engine.services.curator_scheduler import register_user_job

    app = build_app()
    app.dependency_overrides[get_kms] = lambda: kms_override

    async with app.router.lifespan_context(app):
        scheduler = app.state.curator_scheduler
        session_factory = app.state.curator_session_factory
        kms = app.state.curator_kms
        settings = Settings()

        synthetic_user_id = uuid.uuid4()
        register_user_job(
            scheduler=scheduler,
            user_id=synthetic_user_id,
            settings=settings,
            session_factory=session_factory,
            kms=kms,
        )
        jobs_after_first = {j.id for j in scheduler.get_jobs()}

        register_user_job(
            scheduler=scheduler,
            user_id=synthetic_user_id,
            settings=settings,
            session_factory=session_factory,
            kms=kms,
        )
        jobs_after_second = {j.id for j in scheduler.get_jobs()}

        assert jobs_after_first == jobs_after_second, (
            "register_user_job must be idempotent — second call should "
            "be a no-op, but the scheduler's job set changed."
        )
