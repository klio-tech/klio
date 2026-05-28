"""C1 — POST /v1/spaces/{id}/entries accepts and persists project_id.

The bridge POSTs raw entries (not transcripts) when it has a
pre-resolved memory it wants tagged with a known project_id — e.g.
the MCP `remember` tool with explicit project context. This test
verifies the round-trip: client sends `project_id`, engine stamps
it onto the new Entry row, recall+filter sees it.

Fixtures (`app_client`, `db_session`, `provision`, `seed_project`,
`AuthCtx`) live in `engine/tests/api/conftest.py`.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.entry import Entry
from tests.api.conftest import AuthCtx, provision, seed_project


@pytest.mark.asyncio
async def test_post_entry_tags_with_project_id(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """The POST /v1/spaces/{space}/entries handler accepts a
    `project_id` and stamps it onto the new Entry. The bridge will
    use this directly — verifying the round-trip here catches any
    silent field drop in the schema or handler.
    """
    ctx: AuthCtx = provision(app_client)
    project_id = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/entries-roundtrip.git",
        repo_root_path="/Users/dev/projects/entries-roundtrip",
        display_name="entries-roundtrip",
    )

    r = app_client.post(
        f"/v1/spaces/{ctx.default_space_id}/entries",
        json={
            "kind": "memory",
            "content": "User prefers pnpm over npm.",
            "project_id": str(project_id),
        },
        headers=ctx.auth_header(),
    )
    assert r.status_code == 201, r.text
    entry_id = uuid.UUID(r.json()["id"])

    stmt = select(Entry).where(Entry.id == entry_id)
    entry = (await db_session.execute(stmt)).scalar_one()
    assert entry.project_id == project_id, (
        f"project_id from request body must be persisted; "
        f"got {entry.project_id!r}, expected {project_id!r}"
    )


@pytest.mark.asyncio
async def test_post_entry_without_project_id_is_null(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """Omitting `project_id` results in a NULL-tagged entry. NULL is
    the safe-default: NULL-tagged rows surface in every project's
    recall (B2 design), so legacy clients and ad-hoc writes don't
    silently disappear from the user's view."""
    ctx: AuthCtx = provision(app_client)

    r = app_client.post(
        f"/v1/spaces/{ctx.default_space_id}/entries",
        json={"kind": "memory", "content": "Ad-hoc memory, no project."},
        headers=ctx.auth_header(),
    )
    assert r.status_code == 201, r.text
    entry_id = uuid.UUID(r.json()["id"])

    stmt = select(Entry).where(Entry.id == entry_id)
    entry = (await db_session.execute(stmt)).scalar_one()
    assert entry.project_id is None, (
        f"omitting project_id should produce a NULL-tagged entry; "
        f"got {entry.project_id!r}"
    )


# ---------------------------------------------------------------------------
# UI-1 — project_id surfaced on EntryResponse + list_entries project filter
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_entry_response_includes_project_id(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """GET /v1/spaces/{space}/entries surfaces `project_id` on each
    response row. The trust-app dashboard reads this field to badge
    each memory with its project — a silent null here would make every
    real (project-tagged) entry look uncategorized.
    """
    ctx: AuthCtx = provision(app_client)
    project_id = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/resp-project.git",
        repo_root_path="/Users/dev/resp-project",
        display_name="resp-project",
    )

    w = app_client.post(
        f"/v1/spaces/{ctx.default_space_id}/entries",
        json={
            "kind": "memory",
            "content": "Tagged memory.",
            "project_id": str(project_id),
        },
        headers=ctx.auth_header(),
    )
    assert w.status_code == 201, w.text
    # The write response itself must carry project_id too (the POST
    # handler is one of the EntryResponse construction sites).
    assert w.json()["project_id"] == str(project_id), w.text

    r = app_client.get(
        f"/v1/spaces/{ctx.default_space_id}/entries",
        headers=ctx.auth_header(),
    )
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 1, rows
    assert rows[0]["project_id"] == str(project_id)


@pytest.mark.asyncio
async def test_list_entries_filters_by_project_id(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """GET /v1/spaces/{space}/entries?project_id=A returns entries
    tagged to A PLUS NULL-tagged (uncategorized / pre-0.7.0) entries,
    but NOT entries tagged to a different project B.

    This mirrors recall's B2 semantics: a user browsing one project
    still sees their global/legacy pool, the safe default that avoids
    "where did my old memories go".
    """
    ctx: AuthCtx = provision(app_client)
    project_a = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/filter-a.git",
        repo_root_path="/Users/x/filter-a",
        display_name="filter-a",
    )
    project_b = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/filter-b.git",
        repo_root_path="/Users/x/filter-b",
        display_name="filter-b",
    )

    def _write(content: str, project_id: uuid.UUID | None) -> str:
        body: dict = {"kind": "memory", "content": content}
        if project_id is not None:
            body["project_id"] = str(project_id)
        resp = app_client.post(
            f"/v1/spaces/{ctx.default_space_id}/entries",
            json=body,
            headers=ctx.auth_header(),
        )
        assert resp.status_code == 201, resp.text
        return resp.json()["id"]

    a_id = _write("A memory", project_a)
    b_id = _write("B memory", project_b)
    null_id = _write("Uncategorized memory", None)

    r = app_client.get(
        f"/v1/spaces/{ctx.default_space_id}/entries",
        params={"project_id": str(project_a)},
        headers=ctx.auth_header(),
    )
    assert r.status_code == 200, r.text
    returned = {row["id"] for row in r.json()}
    assert a_id in returned, "project A's own entry must be returned"
    assert null_id in returned, "NULL-tagged entries must surface (B2)"
    assert b_id not in returned, "project B's entry must NOT leak in"


@pytest.mark.asyncio
async def test_list_entries_no_project_filter_returns_all(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """Omitting `project_id` preserves the pre-UI-1 behavior: every
    non-deleted entry in the space is returned regardless of project
    tag. This guards against the filter accidentally becoming
    mandatory."""
    ctx: AuthCtx = provision(app_client)
    project_a = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/all-a.git",
        repo_root_path="/Users/x/all-a",
        display_name="all-a",
    )
    project_b = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/all-b.git",
        repo_root_path="/Users/x/all-b",
        display_name="all-b",
    )

    def _write(content: str, project_id: uuid.UUID | None) -> str:
        body: dict = {"kind": "memory", "content": content}
        if project_id is not None:
            body["project_id"] = str(project_id)
        resp = app_client.post(
            f"/v1/spaces/{ctx.default_space_id}/entries",
            json=body,
            headers=ctx.auth_header(),
        )
        assert resp.status_code == 201, resp.text
        return resp.json()["id"]

    a_id = _write("A memory", project_a)
    b_id = _write("B memory", project_b)
    null_id = _write("Uncategorized memory", None)

    r = app_client.get(
        f"/v1/spaces/{ctx.default_space_id}/entries",
        headers=ctx.auth_header(),
    )
    assert r.status_code == 200, r.text
    returned = {row["id"] for row in r.json()}
    assert {a_id, b_id, null_id} <= returned


@pytest.mark.asyncio
async def test_list_entries_unknown_project_id_yields_null_subset(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """Pins the unknown-project_id decision: filtering by a project_id
    the caller does NOT own does not 404 and does not leak. The filter
    is a browse convenience, so an unknown id simply resolves to the
    NULL-tagged subset (the OR-NULL branch always applies, the
    project-match branch matches nothing).

    Distinct from recall's `project` arg, which 404s on unknown values
    because recall is the read path the agent depends on for
    correctness; the dashboard browse filter always sources its
    project_id from GET /v1/projects, so an unknown id here can only
    come from a stale tab and is harmless to treat as "show
    uncategorized".
    """
    ctx: AuthCtx = provision(app_client)
    project_a = await seed_project(
        db_session,
        user_id=ctx.user_id,
        git_remote="git@github.com:klio-tech/unknown-a.git",
        repo_root_path="/Users/x/unknown-a",
        display_name="unknown-a",
    )

    def _write(content: str, project_id: uuid.UUID | None) -> str:
        body: dict = {"kind": "memory", "content": content}
        if project_id is not None:
            body["project_id"] = str(project_id)
        resp = app_client.post(
            f"/v1/spaces/{ctx.default_space_id}/entries",
            json=body,
            headers=ctx.auth_header(),
        )
        assert resp.status_code == 201, resp.text
        return resp.json()["id"]

    a_id = _write("A memory", project_a)
    null_id = _write("Uncategorized memory", None)

    bogus_project_id = uuid.uuid4()
    r = app_client.get(
        f"/v1/spaces/{ctx.default_space_id}/entries",
        params={"project_id": str(bogus_project_id)},
        headers=ctx.auth_header(),
    )
    assert r.status_code == 200, r.text
    returned = {row["id"] for row in r.json()}
    assert null_id in returned, "NULL-tagged entries always surface"
    assert a_id not in returned, "unknown project must not match A's entry"
