"""E1 + F1 — POST /v1/projects/ensure and POST /v1/projects/{id}/promote.

The bridge's `cloud.Client.EnsureProject` lands on `/ensure` on every
hook fire that resolved a project from the working directory. The
endpoint is a thin handler over `ProjectService.ensure` — the heavy
lifting (remote vs path dedup, SAVEPOINT-scoped concurrent INSERT
recovery, `last_seen_at` bumps) lives in the service.

`/promote` is the F1 escape valve: a project can be elevated from
"tagged in default space" to "owning a dedicated space" when it needs
different embeddings, isolated KMS, or atomic forget semantics. See
`docs/plans/2026-05-27-per-project-memory-scoping-design.md` §6.

This test file covers the API-surface invariants the bridge + CLI
depend on:

  /ensure:
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

  /promote (F1):
  1. Assigning an existing space updates `project.dedicated_space_id`
     and leaves the space untouched.
  2. Supplying an embedding model creates a new dedicated space with
     that model and pins the project to it.
  3. Both modes set simultaneously → 422 (ambiguous).
  4. Neither mode set → 422 (must pick one).
  5. Unknown project_id (or another user's) → 404 (no-leak).
  6. Unknown / cross-tenant space_id → 404 (no-leak).
  7. User A cannot promote User B's project even with A's own valid
     space_id — gets 404, preserving tenant isolation.

Fixtures (`app_client`, `db_session`, `provision`, `AuthCtx`) live in
`engine/tests/api/conftest.py`.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.project import Project
from klio_engine.models.space import Space
from tests.api.conftest import AuthCtx, provision, seed_project, seed_space


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


# ---------------------------------------------------------------------------
# F1 — POST /v1/projects/{project_id}/promote
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_promote_assigns_existing_space(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """Simplest promote path: assign an existing space.

    The handler must:
      - set `project.dedicated_space_id` to the supplied space_id
      - leave the existing Space row otherwise untouched
        (no embedding model mutation, no new row created)
      - return both IDs on the wire so the CLI / bridge can confirm
    """
    ctx = provision(app_client)
    project_id = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/Users/x/klio",
        display_name="klio-tech/klio",
    )
    space_id = await seed_space(
        db_session,
        user_id=ctx.user_id,
        name="Pre-existing",
        slug="pre-existing",
        embedding_model="stub",
    )

    resp = app_client.post(
        f"/v1/projects/{project_id}/promote",
        headers=ctx.auth_header(),
        json={"space_id": str(space_id)},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert uuid.UUID(body["project_id"]) == project_id
    assert uuid.UUID(body["dedicated_space_id"]) == space_id

    # Round-trip through an independent session to confirm the commit
    # landed and the existing Space row is unchanged.
    project = (
        await db_session.execute(
            select(Project).where(Project.id == project_id)
        )
    ).scalar_one()
    assert project.dedicated_space_id == space_id

    space = (
        await db_session.execute(select(Space).where(Space.id == space_id))
    ).scalar_one()
    assert space.user_id == ctx.user_id
    assert space.name == "Pre-existing"
    assert space.embedding_model == "stub"


@pytest.mark.asyncio
async def test_promote_creates_dedicated_space_with_embedding(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """Other promote path: supply an embedding model. The handler
    creates a new Space pinned to that model, with a name derived from
    the project's display_name, then points the project at it.

    Verifies the dim is sourced from the registry rather than being
    hardcoded — `stub` is pinned at 1536-dim in
    `services/embedding_models.py::EMBEDDING_MODELS`.
    """
    ctx = provision(app_client)
    project_id = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/Users/x/klio",
        display_name="klio-tech/klio",
    )

    resp = app_client.post(
        f"/v1/projects/{project_id}/promote",
        headers=ctx.auth_header(),
        json={"embedding_model": "stub"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    new_space_id = uuid.UUID(body["dedicated_space_id"])
    assert uuid.UUID(body["project_id"]) == project_id

    project = (
        await db_session.execute(
            select(Project).where(Project.id == project_id)
        )
    ).scalar_one()
    assert project.dedicated_space_id == new_space_id

    new_space = (
        await db_session.execute(
            select(Space).where(Space.id == new_space_id)
        )
    ).scalar_one()
    assert new_space.user_id == ctx.user_id
    assert new_space.embedding_model == "stub"
    assert new_space.embedding_dim == 1536  # registry pin
    # Name derived from the project's display_name with a "(dedicated)"
    # suffix so the user recognizes it in the spaces list.
    assert "klio-tech/klio" in new_space.name
    assert "dedicated" in new_space.name.lower()


@pytest.mark.asyncio
async def test_promote_rejects_both_modes(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """Both `space_id` and `embedding_model` set → 422 (ambiguous).
    The caller must pick exactly one: assign an existing space, OR
    create a new one with the given model. Allowing both would make
    the override semantics undefined."""
    ctx = provision(app_client)
    project_id = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/Users/x/klio",
        display_name="klio-tech/klio",
    )
    space_id = await seed_space(
        db_session,
        user_id=ctx.user_id,
        name="Pre-existing",
        slug="pre-existing",
        embedding_model="stub",
    )

    resp = app_client.post(
        f"/v1/projects/{project_id}/promote",
        headers=ctx.auth_header(),
        json={"space_id": str(space_id), "embedding_model": "stub"},
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.asyncio
async def test_promote_rejects_neither_mode(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """Empty body → 422 (must supply exactly one of the two).
    Mirrors the `/ensure` cross-field validation: pydantic alone
    cannot express XOR, so the handler enforces it explicitly."""
    ctx = provision(app_client)
    project_id = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/Users/x/klio",
        display_name="klio-tech/klio",
    )

    resp = app_client.post(
        f"/v1/projects/{project_id}/promote",
        headers=ctx.auth_header(),
        json={},
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.asyncio
async def test_promote_404s_on_unknown_project(app_client: TestClient) -> None:
    """A project_id that doesn't exist (or belongs to another user)
    → 404. Using 404 not 403 deliberately: a 403 would leak the
    existence of a row owned by another tenant."""
    ctx = provision(app_client)
    bogus_project_id = uuid.uuid4()
    resp = app_client.post(
        f"/v1/projects/{bogus_project_id}/promote",
        headers=ctx.auth_header(),
        json={"embedding_model": "stub"},
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.asyncio
async def test_promote_404s_on_unknown_space(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """A space_id that doesn't exist (or belongs to another user)
    → 404. Same no-leak rationale as the unknown-project case."""
    ctx = provision(app_client)
    project_id = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/Users/x/klio",
        display_name="klio-tech/klio",
    )
    bogus_space_id = uuid.uuid4()
    resp = app_client.post(
        f"/v1/projects/{project_id}/promote",
        headers=ctx.auth_header(),
        json={"space_id": str(bogus_space_id)},
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.asyncio
async def test_promote_rejects_unsupported_embedding_model(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """An embedding_model name not in the registry → 422 (clean
    error), not 500. The `services/embedding_models.py::resolve`
    helper raises ValueError; the handler converts that to a 422
    with a clear message."""
    ctx = provision(app_client)
    project_id = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/Users/x/klio",
        display_name="klio-tech/klio",
    )

    resp = app_client.post(
        f"/v1/projects/{project_id}/promote",
        headers=ctx.auth_header(),
        json={"embedding_model": "this-model-does-not-exist"},
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.asyncio
async def test_promote_isolates_per_user(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """User A cannot promote User B's project, even when supplying
    A's own valid space_id. The lookup uses (project_id, user_id) so
    A's request to promote B's project_id misses the projects table
    and returns 404. This guards against the most subtle tenant-leak
    bug: passing a legitimately-yours space to elevate someone else's
    project."""
    ctx_a = provision(app_client)
    ctx_b = provision(app_client)

    # User B owns the project.
    project_b_id = await seed_project(
        db_session,
        user_id=ctx_b.user_id,
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/Users/x/klio",
        display_name="klio-tech/klio",
    )
    # User A owns a valid space of their own.
    space_a_id = await seed_space(
        db_session,
        user_id=ctx_a.user_id,
        name="A's space",
        slug="a-space",
        embedding_model="stub",
    )

    # A tries to promote B's project to A's space → 404, not 403.
    resp = app_client.post(
        f"/v1/projects/{project_b_id}/promote",
        headers=ctx_a.auth_header(),
        json={"space_id": str(space_a_id)},
    )
    assert resp.status_code == 404, resp.text

    # Verify B's project is unchanged in the DB.
    project_b = (
        await db_session.execute(
            select(Project).where(Project.id == project_b_id)
        )
    ).scalar_one()
    assert project_b.dedicated_space_id is None


@pytest.mark.asyncio
async def test_promote_rejects_other_users_space_id(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """User A owns the project and tries to assign User B's space_id
    → 404 (the space lookup is scoped by user_id). Without this scoping,
    A could pin their project to B's space and route writes there."""
    ctx_a = provision(app_client)
    ctx_b = provision(app_client)

    project_a_id = await seed_project(
        db_session,
        user_id=ctx_a.user_id,
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/Users/x/klio",
        display_name="klio-tech/klio",
    )
    space_b_id = await seed_space(
        db_session,
        user_id=ctx_b.user_id,
        name="B's space",
        slug="b-space",
        embedding_model="stub",
    )

    resp = app_client.post(
        f"/v1/projects/{project_a_id}/promote",
        headers=ctx_a.auth_header(),
        json={"space_id": str(space_b_id)},
    )
    assert resp.status_code == 404, resp.text

    project_a = (
        await db_session.execute(
            select(Project).where(Project.id == project_a_id)
        )
    ).scalar_one()
    assert project_a.dedicated_space_id is None


@pytest.mark.asyncio
async def test_promote_requires_auth(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """No Bearer token → 401. The endpoint is per-user; unauthenticated
    access is never valid."""
    ctx = provision(app_client)
    project_id = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/Users/x/klio",
        display_name="klio-tech/klio",
    )
    resp = app_client.post(
        f"/v1/projects/{project_id}/promote",
        json={"embedding_model": "stub"},
    )
    assert resp.status_code == 401, resp.text


@pytest.mark.asyncio
async def test_promote_with_embedding_grants_write_permission_to_promoter(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """Regression: the new dedicated space MUST include a Permission
    row for the promoting agent, or every subsequent write tagged with
    that project_id is 403'd silently by `check_permission` (services/
    acl.py).

    Bug history: the F1 first-pass promote() created the Space row but
    forgot the per-agent Permission grant — the space appeared in the
    user's spaces list but was unwritable by the agent that minted it.
    The defense is to assert end-to-end: promote → POST /entries on
    the new dedicated_space_id → 201 with the correct content.
    """
    ctx = provision(app_client)
    project_id = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/Users/x/klio",
        display_name="klio-tech/klio",
    )

    promote_resp = app_client.post(
        f"/v1/projects/{project_id}/promote",
        headers=ctx.auth_header(),
        json={"embedding_model": "stub"},
    )
    assert promote_resp.status_code == 200, promote_resp.text
    dedicated_space_id = uuid.UUID(promote_resp.json()["dedicated_space_id"])

    # Load-bearing assertion: a write tagged with the new dedicated
    # space must succeed for the promoting agent. If the Permission
    # grant is missing, the ACL check fires and this returns 403.
    write_resp = app_client.post(
        f"/v1/spaces/{dedicated_space_id}/entries",
        headers=ctx.auth_header(),
        json={"kind": "memory", "content": "test entry on dedicated space"},
    )
    assert write_resp.status_code == 201, (
        f"new dedicated space rejected the promoting agent's write: "
        f"{write_resp.status_code} {write_resp.text}"
    )


@pytest.mark.asyncio
async def test_promote_twice_rejects_409(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """Re-promote after a successful promote returns 409 — projects
    are promoted once. A second call would otherwise either silently
    orphan the previous dedicated space (existing-space mode) or
    collide on the deterministic `dedicated-<project_id>` slug
    UniqueConstraint and surface as a 500 (new-space mode).

    Demoting (clearing `dedicated_space_id`) is not a v0.7 operation;
    when it lands, the 409 here gives the CLI a clean signal to drive
    a demote-then-promote dance.
    """
    ctx = provision(app_client)
    project_id = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/Users/x/klio",
        display_name="klio-tech/klio",
    )
    r1 = app_client.post(
        f"/v1/projects/{project_id}/promote",
        headers=ctx.auth_header(),
        json={"embedding_model": "stub"},
    )
    assert r1.status_code == 200, r1.text
    r2 = app_client.post(
        f"/v1/projects/{project_id}/promote",
        headers=ctx.auth_header(),
        json={"embedding_model": "stub"},
    )
    assert r2.status_code == 409, r2.text
    assert "already promoted" in r2.json()["detail"]


# ---------------------------------------------------------------------------
# UI-1 — GET /v1/projects (list with per-project entry counts)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_projects_returns_user_projects_with_counts(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """GET /v1/projects returns the caller's projects, ordered by
    `last_seen_at` desc (most-recently-active first), each carrying a
    `entry_count` of its non-deleted tagged entries.

    Two projects are seeded in order (A then B); B is seeded later so
    its `last_seen_at` is strictly greater (PostgreSQL `now()` is the
    transaction-start time and `seed_project` commits each project in
    its own transaction). Three entries are tagged to project A and
    one to project B, so the counts are independently verifiable and
    can't be confused with the ordering.
    """
    ctx = provision(app_client)
    project_a = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/project-a.git",
        repo_root_path="/Users/x/project-a",
        display_name="klio-tech/project-a",
    )
    project_b = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/project-b.git",
        repo_root_path="/Users/x/project-b",
        display_name="klio-tech/project-b",
    )

    # 3 entries into A, 1 into B. Written via the API so the full
    # write path (encryption, project tagging) is exercised.
    for i in range(3):
        r = app_client.post(
            f"/v1/spaces/{ctx.default_space_id}/entries",
            json={
                "kind": "memory",
                "content": f"A memory {i}",
                "project_id": str(project_a),
            },
            headers=ctx.auth_header(),
        )
        assert r.status_code == 201, r.text
    r = app_client.post(
        f"/v1/spaces/{ctx.default_space_id}/entries",
        json={
            "kind": "memory",
            "content": "B memory",
            "project_id": str(project_b),
        },
        headers=ctx.auth_header(),
    )
    assert r.status_code == 201, r.text

    resp = app_client.get("/v1/projects", headers=ctx.auth_header())
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 2, rows

    # Ordered by last_seen_at desc → B (seeded last) first, then A.
    assert uuid.UUID(rows[0]["id"]) == project_b
    assert uuid.UUID(rows[1]["id"]) == project_a

    by_id = {uuid.UUID(r["id"]): r for r in rows}
    assert by_id[project_a]["entry_count"] == 3
    assert by_id[project_b]["entry_count"] == 1

    # Spot-check the full row shape the dashboard depends on.
    a_row = by_id[project_a]
    assert a_row["display_name"] == "klio-tech/project-a"
    assert a_row["git_remote"] == "git@github.com:klio-tech/project-a.git"
    assert a_row["repo_root_path"] == "/Users/x/project-a"
    assert a_row["dedicated_space_id"] is None
    assert "created_at" in a_row
    assert "last_seen_at" in a_row


@pytest.mark.asyncio
async def test_list_projects_is_tenant_scoped(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """User A's GET /v1/projects never includes User B's projects.
    The query is scoped to `projects.user_id == ctx.user_id`; without
    that filter the dashboard would leak another tenant's repo names."""
    ctx_a = provision(app_client)
    ctx_b = provision(app_client)

    project_a = await seed_project(
        db_session,
        user_id=ctx_a.user_id,
        git_remote="git@github.com:klio-tech/a-only.git",
        repo_root_path="/Users/x/a-only",
        display_name="klio-tech/a-only",
    )
    project_b = await seed_project(
        db_session,
        user_id=ctx_b.user_id,
        git_remote="git@github.com:klio-tech/b-only.git",
        repo_root_path="/Users/x/b-only",
        display_name="klio-tech/b-only",
    )

    resp = app_client.get("/v1/projects", headers=ctx_a.auth_header())
    assert resp.status_code == 200, resp.text
    ids = {uuid.UUID(r["id"]) for r in resp.json()}
    assert project_a in ids
    assert project_b not in ids


@pytest.mark.asyncio
async def test_list_projects_empty_for_new_user(
    app_client: TestClient,
) -> None:
    """A freshly-provisioned user with no projects gets `[]`, not an
    error. The dashboard renders an empty project filter rather than
    crashing on a 404/500."""
    ctx = provision(app_client)
    resp = app_client.get("/v1/projects", headers=ctx.auth_header())
    assert resp.status_code == 200, resp.text
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_projects_requires_auth(app_client: TestClient) -> None:
    """No Bearer token → 401. Project rows are user-scoped, so
    anonymous access is never valid — mirrors /ensure and /promote."""
    resp = app_client.get("/v1/projects")
    assert resp.status_code == 401, resp.text


@pytest.mark.asyncio
async def test_list_projects_orders_ties_by_id_desc(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """When two projects share an identical `last_seen_at`, the list is
    still totally ordered: `Project.id` desc is the deterministic
    tiebreaker.

    `last_seen_at` defaults to `func.now()` (transaction-start time), so
    two projects bumped in the same transaction get byte-identical
    timestamps and a primary-only ORDER BY would return them in an
    arbitrary, vacuum-unstable order. Here we force the tie explicitly:
    seed two projects, then stamp both rows with the SAME literal
    `last_seen_at` via the db_session. The endpoint must then return
    them in `id` desc order regardless of insertion order.
    """
    ctx = provision(app_client)
    project_1 = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/tie-1.git",
        repo_root_path="/Users/x/tie-1",
        display_name="klio-tech/tie-1",
    )
    project_2 = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/tie-2.git",
        repo_root_path="/Users/x/tie-2",
        display_name="klio-tech/tie-2",
    )

    # Force an exact tie on the primary sort key. A timezone-aware
    # literal mirrors the `TIMESTAMPTZ` column type so the comparison is
    # unambiguous and both rows end up byte-identical on `last_seen_at`.
    tie_ts = datetime(2026, 5, 28, 12, 0, 0, tzinfo=timezone.utc)
    await db_session.execute(
        update(Project)
        .where(Project.id.in_([project_1, project_2]))
        .values(last_seen_at=tie_ts)
    )
    await db_session.commit()

    resp = app_client.get("/v1/projects", headers=ctx.auth_header())
    assert resp.status_code == 200, resp.text
    ids = [uuid.UUID(r["id"]) for r in resp.json()]
    # Both seeded projects are present and ordered id-desc. Asserting
    # against `sorted(..., reverse=True)` (not insertion order) is the
    # load-bearing check: the two UUIDs are random, so the expected
    # order is whichever id is numerically larger — exactly what the
    # `Project.id.desc()` tiebreaker produces, independent of which
    # project was seeded first.
    assert ids == sorted([project_1, project_2], reverse=True), (
        "tied last_seen_at must break to id desc deterministically; "
        f"got {ids}"
    )


@pytest.mark.asyncio
async def test_list_projects_excludes_deleted_entries_from_count(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """`entry_count` counts only non-deleted entries. A soft-deleted
    entry (DELETE /v1/entries/{id}) must drop out of the count so the
    dashboard's per-project totals match what the user actually sees in
    the memories list."""
    ctx = provision(app_client)
    project_id = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/count-deleted.git",
        repo_root_path="/Users/x/count-deleted",
        display_name="klio-tech/count-deleted",
    )

    written_ids = []
    for i in range(2):
        r = app_client.post(
            f"/v1/spaces/{ctx.default_space_id}/entries",
            json={
                "kind": "memory",
                "content": f"memory {i}",
                "project_id": str(project_id),
            },
            headers=ctx.auth_header(),
        )
        assert r.status_code == 201, r.text
        written_ids.append(r.json()["id"])

    # Soft-delete one of the two tagged entries.
    d = app_client.delete(
        f"/v1/entries/{written_ids[0]}", headers=ctx.auth_header()
    )
    assert d.status_code == 204, d.text

    resp = app_client.get("/v1/projects", headers=ctx.auth_header())
    assert resp.status_code == 200, resp.text
    by_id = {uuid.UUID(r["id"]): r for r in resp.json()}
    assert by_id[project_id]["entry_count"] == 1
