"""E1 — POST /v1/projects/ensure get-or-create endpoint.

The bridge's `cloud.Client.EnsureProject` lands here on every hook
fire that resolved a project from the working directory. The endpoint
is a thin handler over `ProjectService.ensure` — the heavy lifting
(remote vs path dedup, SAVEPOINT-scoped concurrent INSERT recovery,
`last_seen_at` bumps) lives in the service.

This test file covers the API-surface invariants the bridge depends
on:

  1. First call with `(git_remote, repo_root_path, display_name)`
     persists a row and returns its UUID.
  2. Second call with the same `git_remote` returns the same UUID
     (idempotent get-or-create across multiple hook fires).
  3. Requests missing BOTH `git_remote` AND `repo_root_path` 422 —
     the engine refuses to mint a `cwd`-only project (display name
     alone is too weak a dedup key).
  4. Empty `display_name` 422s — `min_length=1` mirrors the column's
     NOT NULL constraint and the C1 ingest schema.
  5. Empty `git_remote` / `repo_root_path` (`""` not `null`) 422 —
     mirrors the C1 ingest schema, defends against silent project-row
     corruption when a bridge bug forwards a blank `git remote -v`
     output.
  6. Unauthorized requests (no Bearer token) 401.
  7. Cross-tenant isolation: two users sending the same identifiers
     get distinct project rows.

Fixtures (`app_client`, `db_session`, `provision`, `AuthCtx`) live in
`engine/tests/api/conftest.py`.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.project import Project
from tests.api.conftest import AuthCtx, provision


def _ensure_body(
    *,
    git_remote: str | None = None,
    repo_root_path: str | None = None,
    display_name: str | None = "klio-tech/klio",
) -> dict:
    """Construct an EnsureRequest body with only the populated fields.

    `None` means "omit this field entirely" so we can exercise the
    optional-field paths. Empty string ("") is preserved so we can
    exercise the min_length=1 rejection paths.
    """
    body: dict = {}
    if git_remote is not None:
        body["git_remote"] = git_remote
    if repo_root_path is not None:
        body["repo_root_path"] = repo_root_path
    if display_name is not None:
        body["display_name"] = display_name
    return body


@pytest.mark.asyncio
async def test_ensure_creates_project_on_first_call(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """First ensure() call for a given (user, git_remote) inserts a
    project row and returns its UUID. The row is committed (visible to
    an independent session) and carries the supplied identifiers."""
    ctx = provision(app_client)
    resp = app_client.post(
        "/v1/projects/ensure",
        headers=ctx.auth_header(),
        json=_ensure_body(
            git_remote="git@github.com:klio-tech/klio.git",
            repo_root_path="/Users/x/klio",
            display_name="klio-tech/klio",
        ),
    )
    assert resp.status_code == 200, resp.text
    project_id = uuid.UUID(resp.json()["id"])

    # Round-trip via an independent session — the endpoint MUST have
    # committed for the bridge's next request (E2: write tagging) to
    # see the row.
    row = (
        await db_session.execute(
            select(Project).where(Project.id == project_id)
        )
    ).scalar_one()
    assert row.user_id == ctx.user_id
    assert row.git_remote == "git@github.com:klio-tech/klio.git"
    assert row.repo_root_path == "/Users/x/klio"
    assert row.display_name == "klio-tech/klio"


@pytest.mark.asyncio
async def test_ensure_dedupes_on_subsequent_calls(
    app_client: TestClient,
) -> None:
    """Two ensure calls with the same (user, git_remote) return the
    same id — idempotent get-or-create. This is the load-bearing
    invariant for the E2 hook handler, which calls EnsureProject on
    every fire and must NOT spawn duplicate project rows."""
    ctx = provision(app_client)
    body = _ensure_body(
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/Users/x/klio",
        display_name="klio-tech/klio",
    )
    r1 = app_client.post(
        "/v1/projects/ensure", headers=ctx.auth_header(), json=body
    )
    r2 = app_client.post(
        "/v1/projects/ensure", headers=ctx.auth_header(), json=body
    )
    assert r1.status_code == 200, r1.text
    assert r2.status_code == 200, r2.text
    assert r1.json()["id"] == r2.json()["id"]


@pytest.mark.asyncio
async def test_ensure_dedupes_on_path_only_calls(
    app_client: TestClient,
) -> None:
    """Detached-checkout dedup: two calls with the same repo_root_path
    and NO git_remote land on the same project row. Mirrors the
    partial unique index `ix_projects_user_path WHERE git_remote IS
    NULL` semantics from migration 0008."""
    ctx = provision(app_client)
    body = _ensure_body(
        repo_root_path="/Users/x/detached-clone",
        display_name="detached-clone",
    )
    r1 = app_client.post(
        "/v1/projects/ensure", headers=ctx.auth_header(), json=body
    )
    r2 = app_client.post(
        "/v1/projects/ensure", headers=ctx.auth_header(), json=body
    )
    assert r1.status_code == 200, r1.text
    assert r2.status_code == 200, r2.text
    assert r1.json()["id"] == r2.json()["id"]


@pytest.mark.asyncio
async def test_ensure_rejects_both_keys_missing(
    app_client: TestClient,
) -> None:
    """`display_name`-only body 422s. The handler enforces this BEFORE
    delegating to `ProjectService.ensure` (which also raises ValueError
    on this input — defense-in-depth)."""
    ctx = provision(app_client)
    resp = app_client.post(
        "/v1/projects/ensure",
        headers=ctx.auth_header(),
        json=_ensure_body(display_name="no-keys"),
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.asyncio
async def test_ensure_rejects_empty_display_name(
    app_client: TestClient,
) -> None:
    """`display_name=""` 422s on `min_length=1`. The column is NOT
    NULL on the DB; rejecting empty strings at the schema layer keeps
    the error response shape consistent (422 not 500)."""
    ctx = provision(app_client)
    resp = app_client.post(
        "/v1/projects/ensure",
        headers=ctx.auth_header(),
        json=_ensure_body(
            git_remote="git@github.com:x/y.git", display_name=""
        ),
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.asyncio
async def test_ensure_rejects_missing_display_name(
    app_client: TestClient,
) -> None:
    """`display_name` is required (no default) — omitting it 422s.
    Distinct from empty-string rejection because pydantic surfaces
    the two failures via different error types ('missing' vs
    'string_too_short')."""
    ctx = provision(app_client)
    resp = app_client.post(
        "/v1/projects/ensure",
        headers=ctx.auth_header(),
        json={"git_remote": "git@github.com:x/y.git"},
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.asyncio
async def test_ensure_rejects_empty_git_remote(
    app_client: TestClient,
) -> None:
    """`git_remote=""` 422s. A bridge bug that forwards an empty
    `git remote -v` output could otherwise bypass the
    'at-least-one-key' gate via repo_root_path and silently corrupt
    project dedup — see the long comment in
    `schemas/ingest.py::IngestTranscriptRequest`."""
    ctx = provision(app_client)
    resp = app_client.post(
        "/v1/projects/ensure",
        headers=ctx.auth_header(),
        json={
            "git_remote": "",
            "repo_root_path": "/Users/x/klio",
            "display_name": "klio",
        },
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.asyncio
async def test_ensure_rejects_empty_repo_root_path(
    app_client: TestClient,
) -> None:
    """`repo_root_path=""` 422s — same dedup-corruption defense as
    empty git_remote."""
    ctx = provision(app_client)
    resp = app_client.post(
        "/v1/projects/ensure",
        headers=ctx.auth_header(),
        json={
            "git_remote": "git@github.com:x/y.git",
            "repo_root_path": "",
            "display_name": "klio",
        },
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.asyncio
async def test_ensure_requires_auth(app_client: TestClient) -> None:
    """No Bearer token → 401. The endpoint is per-user (project rows
    are user-scoped) so anonymous access is never valid."""
    resp = app_client.post(
        "/v1/projects/ensure",
        json=_ensure_body(
            git_remote="git@github.com:klio-tech/klio.git",
            display_name="klio-tech/klio",
        ),
    )
    assert resp.status_code == 401, resp.text


@pytest.mark.asyncio
async def test_ensure_isolates_per_user(app_client: TestClient) -> None:
    """Two users sending the same identifiers get distinct project
    rows — `(user_id, git_remote)` is the dedup key, not `git_remote`
    alone. Tenant isolation invariant."""
    ctx_a = provision(app_client)
    ctx_b = provision(app_client)
    body = _ensure_body(
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/Users/x/klio",
        display_name="klio-tech/klio",
    )
    r_a = app_client.post(
        "/v1/projects/ensure", headers=ctx_a.auth_header(), json=body
    )
    r_b = app_client.post(
        "/v1/projects/ensure", headers=ctx_b.auth_header(), json=body
    )
    assert r_a.status_code == 200, r_a.text
    assert r_b.status_code == 200, r_b.text
    assert r_a.json()["id"] != r_b.json()["id"]
