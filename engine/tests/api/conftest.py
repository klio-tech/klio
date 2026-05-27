"""Shared fixtures for engine API integration tests.

Three test files under `tests/api/` (`test_recall_endpoint.py`,
`test_ingest_endpoint.py`, `test_entries_endpoint.py`) all need the
same machinery: a TestClient pointed at the `klio_test` Postgres, a
standalone AsyncSession for seeding rows the API request will read,
an `AuthCtx` provisioned via `/v1/users/provision`, and a helper for
calling `ProjectService.ensure` against the same DB.

This conftest is the single source of truth. Each test file imports
nothing — pytest discovers the fixtures by name resolution.

Distinct from `engine/tests/conftest.py::session`: that fixture creates
a *per-test schema* for unit tests against the SQLAlchemy ORM, with
the production-DB guardrail in front. The fixtures here run against
the *public* schema that the FastAPI app's `get_session` dependency
uses — so the request flow under test exercises the same code path
production will. They use the `klio_test` DB explicitly (never
`klio`) so a polluted test DB cannot bleed into production-shaped
data.
"""
from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass

import boto3
import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from moto import mock_aws
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from klio_engine.api.auth import _mint_for_test
from klio_engine.api.main import build_app
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.dependencies import get_kms
from klio_engine.models.space import Space
from klio_engine.services.embedding_models import resolve as resolve_embed_model
from klio_engine.services.projects import ProjectService

JWT_SECRET = "test-secret-do-not-use-in-prod"

# The endpoints under test read/write against the engine's configured
# Postgres. We point them at the dedicated `klio_test` DB so a polluted
# `klio` (production-shape) doesn't bleed in. Note: this is the same
# URL test files read via KLIO_TEST_DATABASE_URL — pinned here so the
# fixture is reproducible without ambient env.
TEST_DB_URL = os.getenv(
    "KLIO_TEST_DATABASE_URL",
    "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio_test",
)


@dataclass
class AuthCtx:
    """Provisioned identity for a single test.

    Bundles together the freshly-minted access token, the user/agent
    IDs, the default space ID (created automatically by `/v1/users/
    provision`), and the refresh token. `auth_header()` produces the
    Bearer header tests pass to every authenticated request.
    """

    user_id: uuid.UUID
    agent_id: uuid.UUID
    default_space_id: uuid.UUID
    api_key: str
    access_token: str

    def auth_header(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.access_token}"}


@pytest.fixture
def app_client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """TestClient pointed at the engine's `klio_test` Postgres.

    Resets the module-level engine/factory cache before and after each
    test so the freshly-monkeypatched env wins — without this, the
    second test in a session would silently reuse the first test's
    engine and the env override would be a no-op.
    """
    monkeypatch.setenv("KLIO_DATABASE_URL", TEST_DB_URL)
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


@pytest_asyncio.fixture
async def db_session() -> AsyncIterator[AsyncSession]:
    """A standalone AsyncSession bound to the same DB the app uses,
    for seeding projects (and other rows) before firing an API
    request, and for asserting persisted state afterwards.

    Distinct from the top-level conftest's `session` fixture because
    that one creates a per-test schema; we need the *public* schema
    that the FastAPI app's `get_session` dependency uses.
    """
    engine = create_async_engine(TEST_DB_URL, pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with session_factory() as s:
            yield s
    finally:
        await engine.dispose()


async def seed_project(
    db_session: AsyncSession,
    *,
    user_id: uuid.UUID,
    git_remote: str | None,
    repo_root_path: str | None,
    display_name: str,
) -> uuid.UUID:
    """Create a project row via the same get-or-create path the bridge
    uses in production (E2). Commits inside the supplied session so
    the TestClient request below sees it."""
    svc = ProjectService()
    project = await svc.ensure(
        db_session,
        user_id=user_id,
        git_remote=git_remote,
        repo_root_path=repo_root_path,
        display_name=display_name,
    )
    await db_session.commit()
    return project.id


async def seed_space(
    db_session: AsyncSession,
    *,
    user_id: uuid.UUID,
    name: str,
    slug: str,
    embedding_model: str | None = None,
) -> uuid.UUID:
    """Insert a Space row directly for tests that need a pre-existing
    space (promote-to-existing-space path, cross-tenant isolation).

    Uses the same `resolve` registry the production /v1/spaces handler
    uses (`api/spaces.py::create_space`) so the embed_model + embed_dim
    pinned on the row match what the engine would have minted via the
    HTTP path. Commits before returning so the TestClient request
    under test reads the committed row.

    The default `embedding_model=None` resolves to the registry default
    (currently `ollama/nomic-embed-text`, 768-dim); test-env config
    sets `KLIO_EMBEDDING_MODEL=stub` so the default actually used by
    `_default_embedding_model` would be `stub` — but here we want a
    deterministic pin regardless of env, so we resolve explicitly.
    """
    spec = resolve_embed_model(embedding_model)
    space = Space(
        user_id=user_id,
        name=name,
        slug=slug,
        embedding_model=spec.name,
        embedding_dim=spec.dim,
    )
    db_session.add(space)
    await db_session.flush()
    space_id = space.id
    await db_session.commit()
    return space_id


def provision(client: TestClient) -> AuthCtx:
    """Provision a fresh user+agent and return the AuthCtx.

    Each call uses a unique `install_id` so multiple invocations from
    the same test produce distinct identities (needed for cross-tenant
    isolation tests).
    """
    body = {"agent_kind": "claude-code", "install_id": str(uuid.uuid4())}
    r = client.post("/v1/users/provision", json=body)
    assert r.status_code == 201, r.text
    p = r.json()
    user_id = uuid.UUID(p["user_id"])
    agent_id = uuid.UUID(p["agent_id"])
    access = _mint_for_test(
        JWT_SECRET, user_id, agent_id, ["read", "write", "admin"], ttl=3600
    )
    return AuthCtx(
        user_id=user_id,
        agent_id=agent_id,
        default_space_id=uuid.UUID(p["default_space_id"]),
        api_key=p["api_key"],
        access_token=access,
    )


def write_memory(client: TestClient, ctx: AuthCtx, content: str) -> None:
    """Write a memory entry via the API. Used by recall tests that
    need NULL-tagged entries (the safe default for legacy / no-project
    writes) seeded before the recall request fires."""
    r = client.post(
        f"/v1/spaces/{ctx.default_space_id}/entries",
        json={"kind": "memory", "content": content},
        headers=ctx.auth_header(),
    )
    assert r.status_code == 201, r.text
