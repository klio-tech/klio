"""Recall endpoint accepts an optional `project` filter (B3).

Covers the four resolution branches added to
`klio_engine.api.entries.recall`:

  - `body.project` is a UUID owned by the caller → scoped recall.
  - `body.project` is a git_remote string owned by the caller →
    resolved via the `projects.git_remote` column → scoped recall.
  - `body.project == "any"` → explicit cross-project escape hatch
    (same as omitting the field; preserves v0.6 behaviour).
  - `body.project` doesn't match any project the caller owns → 404
    (never silently widens to "all entries" — that would be a footgun).

Pattern mirrors `engine/tests/test_api_engine.py`: per-file
`app_client` TestClient fixture + `_provision()` helper. Projects
that need to exist before the API call are seeded via
`ProjectService.ensure` against the same DB URL the app is pointed
at, in a separate AsyncSession opened+committed before the request
fires.
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
from klio_engine.services.projects import ProjectService

JWT_SECRET = "test-secret-do-not-use-in-prod"

# The recall endpoint reads/writes against the engine's configured
# Postgres. We point it at the dedicated `klio_test` DB so a polluted
# `klio` (production-shape) doesn't bleed in. Note: this is the same
# URL test files read via KLIO_TEST_DATABASE_URL — pinned here so the
# fixture is reproducible without ambient env.
_TEST_DB_URL = os.getenv(
    "KLIO_TEST_DATABASE_URL",
    "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio_test",
)


@dataclass
class AuthCtx:
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

    Mirrors `tests/test_api_engine.py::app_client` but uses
    KLIO_TEST_DATABASE_URL (not `klio`) so this suite does not
    pollute production-shaped data.
    """
    monkeypatch.setenv("KLIO_DATABASE_URL", _TEST_DB_URL)
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
    request.

    Distinct from the conftest `session` fixture because that one
    creates a per-test schema; we need the *public* schema that the
    FastAPI app's `get_session` dependency uses.
    """
    engine = create_async_engine(_TEST_DB_URL, pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with session_factory() as s:
            yield s
    finally:
        await engine.dispose()


async def _seed_project(
    db_session: AsyncSession,
    *,
    user_id: uuid.UUID,
    git_remote: str,
    repo_root_path: str,
    display_name: str,
) -> uuid.UUID:
    """Create a project row for `user_id` using the same get-or-
    create path the bridge will use in production (E2). Commits
    inside this session so the TestClient request below sees it."""
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


def _provision(client: TestClient) -> AuthCtx:
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


def _write_memory(client: TestClient, ctx: AuthCtx, content: str) -> None:
    r = client.post(
        f"/v1/spaces/{ctx.default_space_id}/entries",
        json={"kind": "memory", "content": content},
        headers=ctx.auth_header(),
    )
    assert r.status_code == 201, r.text


@pytest.mark.asyncio
async def test_recall_accepts_project_uuid(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """`project=<uuid>` for a project the caller owns is accepted
    and the recall completes. We don't assert WHICH entries surface
    (writes from this test are project_id=NULL pre-C1 so they all
    surface regardless of the filter — the NULL fallback is the
    point of B2). The assertion here is that the UUID resolution
    path succeeds and the endpoint returns 200, NOT 404."""
    ctx = _provision(app_client)
    project_id = await _seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/repo-uuid.git",
        repo_root_path="/Users/x/repo-uuid",
        display_name="repo-uuid",
    )

    _write_memory(app_client, ctx, "User prefers TypeScript over JavaScript.")

    r = app_client.post(
        f"/v1/spaces/{ctx.default_space_id}/recall",
        json={"query": "language preference", "project": str(project_id)},
        headers=ctx.auth_header(),
    )
    assert r.status_code == 200, r.text
    rows = r.json()
    # Legacy NULL-tagged write surfaces under any project filter (B2
    # safe-default). What we're proving here is "valid UUID → 200,
    # not 404, not 422".
    assert isinstance(rows, list)


@pytest.mark.asyncio
async def test_recall_accepts_project_remote_url(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """`project=<git remote URL>` resolves via the
    `projects.git_remote` column and the recall completes 200.
    Same NULL-fallback caveat as the UUID test — we're asserting
    the resolution path works, not the filter mechanics (covered
    by `tests/services/test_recall.py`)."""
    ctx = _provision(app_client)
    remote = "git@github.com:klio-tech/repo-remote.git"
    await _seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote=remote,
        repo_root_path="/Users/x/repo-remote",
        display_name="repo-remote",
    )

    _write_memory(app_client, ctx, "Project uses Bun.")

    r = app_client.post(
        f"/v1/spaces/{ctx.default_space_id}/recall",
        json={"query": "runtime preference", "project": remote},
        headers=ctx.auth_header(),
    )
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), list)


@pytest.mark.asyncio
async def test_recall_accepts_project_any_widens_to_all(
    app_client: TestClient,
) -> None:
    """`project="any"` is the explicit cross-project escape hatch.
    Identical behaviour to omitting `project` entirely: returns
    every entry the user can see in the space, regardless of
    project tag. No project row needs to exist."""
    ctx = _provision(app_client)

    _write_memory(app_client, ctx, "User prefers TypeScript.")
    _write_memory(app_client, ctx, "Project uses Bun.")
    _write_memory(app_client, ctx, "Likes coffee in the morning.")

    r_any = app_client.post(
        f"/v1/spaces/{ctx.default_space_id}/recall",
        json={"query": "user preferences", "project": "any", "limit": 10},
        headers=ctx.auth_header(),
    )
    assert r_any.status_code == 200, r_any.text

    r_omitted = app_client.post(
        f"/v1/spaces/{ctx.default_space_id}/recall",
        json={"query": "user preferences", "limit": 10},
        headers=ctx.auth_header(),
    )
    assert r_omitted.status_code == 200, r_omitted.text

    # "any" must produce the same id-set as omitting the field. We
    # compare ids (not raw rows) because score floats can drift on
    # the millisecond — but the eligible set must be identical.
    ids_any = {row["id"] for row in r_any.json()}
    ids_omitted = {row["id"] for row in r_omitted.json()}
    assert ids_any == ids_omitted, (
        f"project='any' must match omitted-project recall: "
        f"any={ids_any} omitted={ids_omitted}"
    )
    assert len(ids_any) > 0, "expected at least one entry to surface"


@pytest.mark.asyncio
async def test_recall_unknown_project_returns_404(
    app_client: TestClient,
) -> None:
    """A non-existent project (both UUID-shaped and arbitrary string)
    returns 404. CRITICAL: must NOT 200 with an empty filter — that
    would be the silent-widening footgun B3 is built to prevent."""
    ctx = _provision(app_client)
    _write_memory(app_client, ctx, "User prefers TypeScript.")

    # UUID that doesn't exist for this user.
    r_uuid = app_client.post(
        f"/v1/spaces/{ctx.default_space_id}/recall",
        json={"query": "anything", "project": str(uuid.uuid4())},
        headers=ctx.auth_header(),
    )
    assert r_uuid.status_code == 404, r_uuid.text
    assert "project not found" in r_uuid.json()["detail"].lower()

    # Arbitrary string that can't possibly be a real git remote in
    # this user's projects table.
    r_str = app_client.post(
        f"/v1/spaces/{ctx.default_space_id}/recall",
        json={
            "query": "anything",
            "project": "git@example.invalid:does-not-exist.git",
        },
        headers=ctx.auth_header(),
    )
    assert r_str.status_code == 404, r_str.text
    assert "project not found" in r_str.json()["detail"].lower()
