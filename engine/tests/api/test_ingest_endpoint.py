"""C1 — ingest endpoint accepts cwd + project context.

The bridge calls `/v1/spaces/{id}/ingest/transcript` on every
hook fire that wants to persist a slice of the conversation. With
v0.7.0 per-project scoping, those calls now carry:

  - `cwd`               → persisted on the Session row.
  - `git_remote`        → strongest project identifier.
  - `repo_root_path`    → fallback when no git remote.
  - `project_display_name` → optional UI label override; falls back
    to the basename of repo_root_path or cwd.

This file covers the two behaviour changes the bridge depends on:

  1. Session row's `cwd` column is populated from the request body.
  2. `ProjectService.ensure` is invoked when ANY project context
     field is present, the project row is created on first
     observation, and a re-ingest from the same project does NOT
     duplicate the row (idempotent get-or-create).

Architecture note: this test file uses Option B from the C1 spec —
the recall API's `_resolve_project_arg` stays where it is; the
write path uses `ProjectService.ensure` directly. The two helpers
take fundamentally different inputs (write-side: 3 structured fields;
recall-side: 1 opaque string), so collocating them under a single
service class would be coupling without payoff.

Fixtures (`app_client`, `db_session`, `provision`, `AuthCtx`) live
in `engine/tests/api/conftest.py`.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.project import Project
from klio_engine.models.session import Session as SessionModel
from tests.api.conftest import AuthCtx, provision


def _ingest_body(
    *,
    cwd: str | None = None,
    git_remote: str | None = None,
    repo_root_path: str | None = None,
    project_display_name: str | None = None,
    session_id: uuid.UUID | None = None,
    message: str = "User prefers TypeScript over JavaScript.",
) -> dict:
    """Construct an IngestTranscriptRequest body with the C1 fields
    optionally populated. The stub extractor fires on the regex
    rule for `user prefers ...` → produces a single `memory` entry,
    so we always have at least one written entry to assert against
    when the test cares."""
    body: dict = {
        "session_id": str(session_id or uuid.uuid4()),
        "source_type": "claude-code-session",
        "messages": [{"role": "user", "content": message}],
    }
    if cwd is not None:
        body["cwd"] = cwd
    if git_remote is not None:
        body["git_remote"] = git_remote
    if repo_root_path is not None:
        body["repo_root_path"] = repo_root_path
    if project_display_name is not None:
        body["project_display_name"] = project_display_name
    return body


@pytest.mark.asyncio
async def test_ingest_persists_cwd_on_session(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """Ingest request with `cwd` populates `sessions.cwd` on the
    Session row created for the request. This is the foundation for
    "what was I working on at that timestamp" queries the bridge
    relies on once project-scoped recall is in place."""
    ctx: AuthCtx = provision(app_client)
    session_id = uuid.uuid4()
    cwd = "/Users/dev/projects/klio"

    r = app_client.post(
        f"/v1/spaces/{ctx.default_space_id}/ingest/transcript",
        json=_ingest_body(session_id=session_id, cwd=cwd),
        headers=ctx.auth_header(),
    )
    assert r.status_code == 201, r.text

    # Verify the Session row picked up the cwd.
    stmt = select(SessionModel).where(SessionModel.id == session_id)
    sess = (await db_session.execute(stmt)).scalar_one_or_none()
    assert sess is not None, "ingest must create the Session row"
    assert sess.cwd == cwd, (
        f"sessions.cwd should be persisted from the request body; "
        f"got {sess.cwd!r}, expected {cwd!r}"
    )


@pytest.mark.asyncio
async def test_ingest_creates_project_on_first_observation(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """Ingest with `git_remote` + `repo_root_path` + display_name
    triggers `ProjectService.ensure`, creating the project row on
    first observation. A SECOND ingest with the same git_remote
    must hit the existing row — no duplicate insert. This is the
    idempotency guarantee the bridge relies on (it calls ingest on
    every hook fire, can't afford to spawn a new project row each
    time)."""
    ctx: AuthCtx = provision(app_client)
    git_remote = "git@github.com:klio-tech/klio.git"
    repo_root_path = "/Users/dev/projects/klio"
    display_name = "klio"

    body = _ingest_body(
        cwd=repo_root_path,
        git_remote=git_remote,
        repo_root_path=repo_root_path,
        project_display_name=display_name,
    )

    r1 = app_client.post(
        f"/v1/spaces/{ctx.default_space_id}/ingest/transcript",
        json=body,
        headers=ctx.auth_header(),
    )
    assert r1.status_code == 201, r1.text

    # Snapshot last_seen_at after the first ingest. Each ingest request
    # is its own HTTP transaction, so the DB-side func.now() —
    # transaction_timestamp() on Postgres — resolves to a distinct
    # value between requests. We capture it here to prove the second
    # ingest actually bumped it (vs. silently no-oping past the
    # dedupe).
    stmt_one = select(Project).where(
        Project.user_id == ctx.user_id,
        Project.git_remote == git_remote,
    )
    row_after_first = (await db_session.execute(stmt_one)).scalar_one()
    first_seen_at = row_after_first.last_seen_at

    # The test_projects.py precedent (test_ensure_updates_last_seen_at)
    # sleeps 0.05s between observations so Postgres' clock visibly
    # advances. Mirror that here: without it the two
    # transaction_timestamp() values could fall inside the same
    # microsecond on a fast CI host and the strict-greater-than
    # assertion below would flake.
    await asyncio.sleep(0.05)

    # Second ingest, same project context, different session.
    body2 = _ingest_body(
        cwd=repo_root_path,
        git_remote=git_remote,
        repo_root_path=repo_root_path,
        project_display_name=display_name,
        message="User decided to use pgvector for embeddings.",
    )
    r2 = app_client.post(
        f"/v1/spaces/{ctx.default_space_id}/ingest/transcript",
        json=body2,
        headers=ctx.auth_header(),
    )
    assert r2.status_code == 201, r2.text

    # The SQLAlchemy identity map would otherwise hand us the cached
    # row from the first query (with the stale last_seen_at). Expire
    # forces a re-read of the materialized timestamp the second
    # ingest's UPDATE committed.
    db_session.expire_all()

    # Exactly one project row for this user with this git_remote.
    rows = (await db_session.execute(stmt_one)).scalars().all()
    assert len(rows) == 1, (
        f"two ingests with the same git_remote must dedupe to one row; "
        f"got {len(rows)} rows"
    )
    assert rows[0].display_name == display_name

    # last_seen_at must have advanced on the second observation —
    # that's the entire point of bumping it. Without this assertion,
    # a regression that drops the bump (e.g. a refactor that only sets
    # last_seen_at on INSERT, not on the dedupe UPDATE path) would
    # silently pass the row-count check above since dedupe still works.
    second_seen_at = rows[0].last_seen_at
    assert second_seen_at > first_seen_at, (
        f"last_seen_at must bump on re-ingest: first={first_seen_at}, "
        f"second={second_seen_at}"
    )


@pytest.mark.parametrize(
    "field",
    ["git_remote", "repo_root_path", "project_display_name"],
)
def test_ingest_rejects_empty_string_project_fields(
    app_client: TestClient, field: str
) -> None:
    """Empty strings for the project-identity fields surface as 422,
    not silent corruption. See the comment in `schemas/ingest.py` for
    the rationale: an empty `git_remote` would bypass the gate via the
    other truthy field, then create a phantom project row with
    `git_remote=""` that splits memory from the no-remote version of
    the same project.
    """
    ctx: AuthCtx = provision(app_client)
    body = _ingest_body(
        cwd="/Users/dev/projects/klio",
        git_remote="git@github.com:klio-tech/klio.git",
        repo_root_path="/Users/dev/projects/klio",
        project_display_name="klio",
    )
    # Force the field under test to an empty string. Pydantic's
    # min_length=1 should reject this before the request reaches the
    # service layer.
    body[field] = ""

    r = app_client.post(
        f"/v1/spaces/{ctx.default_space_id}/ingest/transcript",
        json=body,
        headers=ctx.auth_header(),
    )
    assert r.status_code == 422, (
        f"empty {field!r} must be rejected as 422; got {r.status_code}: "
        f"{r.text}"
    )
    # Sanity-check that the error pointed at the field we expected,
    # not some unrelated validation. Pydantic v2 error envelopes have
    # `detail` as a list of error dicts with a `loc` tuple.
    err_locs = {tuple(e.get("loc", [])) for e in r.json().get("detail", [])}
    assert any(field in loc for loc in err_locs), (
        f"422 response should flag {field!r}; got locs {err_locs}"
    )


@pytest.mark.asyncio
async def test_ingest_falls_back_to_basename_when_display_name_missing(
    app_client: TestClient, db_session: AsyncSession
) -> None:
    """When `project_display_name` is omitted but `repo_root_path`
    is supplied, the engine derives the display_name from the path's
    last segment. The bridge's contract: callers SHOULD always send
    display_name, but the engine MUST tolerate the omission so a
    misbehaving bridge doesn't break ingest."""
    ctx: AuthCtx = provision(app_client)
    git_remote = "git@github.com:klio-tech/no-display-name.git"
    repo_root_path = "/Users/dev/projects/my-awesome-repo"

    r = app_client.post(
        f"/v1/spaces/{ctx.default_space_id}/ingest/transcript",
        json=_ingest_body(
            cwd=repo_root_path,
            git_remote=git_remote,
            repo_root_path=repo_root_path,
            # NOTE: project_display_name intentionally omitted.
        ),
        headers=ctx.auth_header(),
    )
    assert r.status_code == 201, r.text

    stmt = select(Project).where(
        Project.user_id == ctx.user_id,
        Project.git_remote == git_remote,
    )
    project = (await db_session.execute(stmt)).scalar_one()
    assert project.display_name == "my-awesome-repo", (
        f"display_name should fall back to basename of repo_root_path; "
        f"got {project.display_name!r}"
    )
