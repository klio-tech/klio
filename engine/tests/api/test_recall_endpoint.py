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

Fixtures (`app_client`, `db_session`, `provision`, `seed_project`,
`write_memory`, `AuthCtx`) live in `engine/tests/api/conftest.py`,
shared with `test_ingest_endpoint.py` and `test_entries_endpoint.py`.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from tests.api.conftest import (
    AuthCtx,
    provision,
    seed_project,
    write_memory,
)


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
    ctx: AuthCtx = provision(app_client)
    project_id = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/repo-uuid.git",
        repo_root_path="/Users/x/repo-uuid",
        display_name="repo-uuid",
    )

    write_memory(app_client, ctx, "User prefers TypeScript over JavaScript.")

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
    ctx: AuthCtx = provision(app_client)
    remote = "git@github.com:klio-tech/repo-remote.git"
    await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote=remote,
        repo_root_path="/Users/x/repo-remote",
        display_name="repo-remote",
    )

    write_memory(app_client, ctx, "Project uses Bun.")

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
    ctx: AuthCtx = provision(app_client)

    write_memory(app_client, ctx, "User prefers TypeScript.")
    write_memory(app_client, ctx, "Project uses Bun.")
    write_memory(app_client, ctx, "Likes coffee in the morning.")

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
    ctx: AuthCtx = provision(app_client)
    write_memory(app_client, ctx, "User prefers TypeScript.")

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


@pytest.mark.asyncio
async def test_recall_normalizes_whitespace_and_empty_string(app_client: TestClient) -> None:
    """The bridge or a malformed client might send `" any"` or `""`
    for project. Both should be treated as cross-project (same as
    omitting the field) — not 404'd into oblivion. Confusing the
    user with `project not found: ` is worse than just doing the
    right thing."""
    ctx: AuthCtx = provision(app_client)
    headers = ctx.auth_header()
    for raw in [" any", "any ", "  any  ", ""]:
        resp = app_client.post(
            f"/v1/spaces/{ctx.default_space_id}/recall",
            headers=headers,
            json={"query": "anything", "project": raw, "limit": 5},
        )
        assert resp.status_code == 200, (
            f"project={raw!r} should normalize to cross-project (None), "
            f"got {resp.status_code}: {resp.text}"
        )
