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
