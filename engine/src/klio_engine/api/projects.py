"""Projects API.

POST /v1/projects/ensure is the bridge-side get-or-create endpoint.
The bridge calls it from the hook handler (E2) once per fire that has
a resolvable project key (`project.Resolve` → `(git_remote,
repo_root_path, display_name)`). The returned UUID is then attached
to the `project` field on the write paths the bridge already calls.

POST /v1/projects/{id}/promote (F1) is the rare on-demand escape valve:
elevate a project from "tagged inside the default space" to "owning a
dedicated space" when it needs different embeddings, isolated KMS, or
atomic forget semantics. The CLI (F2) is the primary caller.

Both endpoints are thin shells over `ProjectService` — the heavy
lifting (remote vs path dedup, SAVEPOINT-scoped concurrent INSERT
recovery, `last_seen_at` bumps, dedicated-space creation, ownership
scoping) lives in the service. This file's job is request-shape
validation, auth scoping, and committing the transaction.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.api.auth import RequestContext, require_auth
from klio_engine.audit.writer import write_audit_event
from klio_engine.dependencies import get_session
from klio_engine.models.entry import Entry
from klio_engine.models.project import Project
from klio_engine.services.projects import ProjectService

router = APIRouter(prefix="/v1/projects", tags=["projects"])


class EnsureRequest(BaseModel):
    """Wire format for POST /v1/projects/ensure.

    Length bounds mirror the C1 ingest schema
    (`schemas/ingest.py::IngestTranscriptRequest`) so the two
    project-context surfaces (ingest + ensure) accept the same inputs
    and reject the same malformed bodies. Empty strings are rejected
    via `min_length=1` for the same dedup-corruption reason documented
    on the ingest schema — a blank `git remote -v` output from a
    detached worktree could otherwise create a phantom project row
    with `git_remote=""` that the partial unique index treats as its
    own slot.
    """

    git_remote: str | None = Field(default=None, min_length=1, max_length=2048)
    repo_root_path: str | None = Field(
        default=None, min_length=1, max_length=4096
    )
    display_name: str = Field(min_length=1, max_length=200)


class EnsureResponse(BaseModel):
    """Project UUID.

    Typed as `uuid.UUID` for consistency with every other engine
    response schema (`schemas/spaces.py`, `schemas/entries.py`, etc.).
    Pydantic serializes `uuid.UUID` to a canonical hyphenated string
    on the wire, which the bridge's Go `uuid.UUID` decoder accepts
    unchanged.
    """

    id: uuid.UUID


class ProjectListItem(BaseModel):
    """One row of GET /v1/projects.

    `entry_count` is the number of non-deleted entries tagged with
    this project — the dashboard renders it as a per-project badge.
    NULL-tagged (uncategorized) entries are deliberately NOT counted
    here: they belong to no single project, so attributing them to one
    would inflate every project's count and double-count the global
    pool. The list-entries browse filter surfaces them alongside any
    selected project (B2), but the count reflects only owned entries.

    Both `git_remote` and `repo_root_path` are nullable, mirroring the
    `projects` columns: a project keyed only by path has no remote, and
    vice-versa. `dedicated_space_id` is None until the project is
    promoted (F1).
    """

    id: uuid.UUID
    display_name: str
    git_remote: str | None
    repo_root_path: str | None
    dedicated_space_id: uuid.UUID | None
    created_at: datetime
    last_seen_at: datetime
    entry_count: int


@router.get("", response_model=list[ProjectListItem])
async def list_projects(
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> list[ProjectListItem]:
    """List the caller's projects with per-project entry counts, for
    the trust-app dashboard's project filter. Ordered by last_seen_at
    desc (most-recently-active first) so the dashboard's default
    selection lands on what the user is currently working on.
    """
    # Correlated scalar subquery for the count. Chosen over a LEFT
    # OUTER JOIN + GROUP BY because it keeps the outer query a plain
    # `select(Project, count)` with no GROUP BY clause to keep in sync
    # with every selected column — adding a project column later can't
    # silently change the grouping. The `ix_entries_project_id` index
    # (migration 0008) serves the per-project COUNT, and the subquery
    # runs once per returned project row (bounded by the user's project
    # count, which is small). `coalesce` is unnecessary: COUNT over an
    # empty match returns 0, not NULL.
    entry_count = (
        select(func.count(Entry.id))
        .where(
            Entry.project_id == Project.id,
            Entry.deleted_at.is_(None),
        )
        .correlate(Project)
        .scalar_subquery()
    )
    # `last_seen_at` alone is not a total order: `ProjectService.ensure`
    # bumps it to `func.now()`, which Postgres evaluates as the
    # transaction-start timestamp. Two projects ensured in the SAME
    # transaction (e.g. a future batch-ensure across a multi-repo
    # workspace) therefore get byte-identical `last_seen_at` values, and
    # a primary-only ORDER BY would return them in an arbitrary,
    # vacuum-unstable order — the dashboard's default selection could
    # flip between requests. `Project.id` (a UUID, unique per row) is the
    # deterministic tiebreaker: desc to keep the most-recently-minted of
    # a same-timestamp pair first, which matches the "recent-first"
    # intent of the primary key.
    stmt = (
        select(Project, entry_count.label("entry_count"))
        .where(Project.user_id == ctx.user_id)
        .order_by(Project.last_seen_at.desc(), Project.id.desc())
    )
    rows = (await session.execute(stmt)).all()
    return [
        ProjectListItem(
            id=project.id,
            display_name=project.display_name,
            git_remote=project.git_remote,
            repo_root_path=project.repo_root_path,
            dedicated_space_id=project.dedicated_space_id,
            created_at=project.created_at,
            last_seen_at=project.last_seen_at,
            entry_count=count,
        )
        for project, count in rows
    ]


@router.post(
    "/ensure",
    response_model=EnsureResponse,
    status_code=status.HTTP_200_OK,
)
async def ensure_project(
    body: EnsureRequest,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> EnsureResponse:
    """Get-or-create a project for the authenticated user.

    Idempotent: repeated calls with the same identifiers return the
    same `project_id` and bump `last_seen_at` so a future "active
    projects" UI can sort by recency.

    Validation order:
      1. Pydantic enforces field types, length bounds, and that
         `display_name` is present + non-empty.
      2. This handler enforces the cross-field invariant that at
         least one of `git_remote` / `repo_root_path` is set
         (Pydantic alone cannot express "either-or-but-not-neither").

    `ProjectService.ensure` also raises `ValueError` if called with
    both keys missing, but we do NOT catch it here. The handler's
    pre-check above produces a more specific error message for the
    HTTP path, and a future call site of `ensure` that forgets the
    pre-check is BETTER served by a loud 500 (with the ValueError in
    the traceback) than a silent 422 — the 500 forces the developer
    to find and fix the missing pre-check rather than masking it.

    The commit happens here, not in the service, mirroring the pattern
    in `api/ingest.py` and `api/entries.py`: services manage row
    state; handlers manage the transaction boundary.
    """
    if body.git_remote is None and body.repo_root_path is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="must supply at least one of git_remote or repo_root_path",
        )
    svc = ProjectService()
    project = await svc.ensure(
        session,
        user_id=ctx.user_id,
        git_remote=body.git_remote,
        repo_root_path=body.repo_root_path,
        display_name=body.display_name,
    )
    await session.commit()
    return EnsureResponse(id=project.id)


class PromoteRequest(BaseModel):
    """Wire format for POST /v1/projects/{project_id}/promote.

    Exactly one of `space_id` / `embedding_model` must be supplied:
      - `space_id`: assign an existing space the user already owns
        (common when consolidating projects, or when an integration
        script pre-provisioned spaces).
      - `embedding_model`: create a new dedicated space pinned to the
        named embedding model (common when isolating a project for
        per-project memory boundaries).

    Allowing both would create ambiguity (does the new space override
    the existing one? is the model field ignored?). The handler
    rejects 422 so the caller is forced to decide.

    `embedding_model` length bounds mirror `Space.embedding_model`
    (`String(120)`) plus headroom for tag suffixes — Ollama can route
    `ollama/nomic-embed-text:latest` and the registry strips the tag
    before lookup. Hard limit at 200 chars (> 120 col limit) so the
    schema layer rejects clearly oversized inputs before they reach
    the column.
    """

    space_id: uuid.UUID | None = None
    embedding_model: str | None = Field(
        default=None, min_length=1, max_length=200
    )


class PromoteResponse(BaseModel):
    """The promoted project's id + its newly-pinned dedicated space.

    Both ids are echoed back so the CLI / bridge can confirm without
    a follow-up GET. Typed as `uuid.UUID` for the same wire-format
    consistency reason as `EnsureResponse`.
    """

    project_id: uuid.UUID
    dedicated_space_id: uuid.UUID


@router.post("/{project_id}/promote", response_model=PromoteResponse)
async def promote_project(
    project_id: uuid.UUID,
    body: PromoteRequest,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> PromoteResponse:
    """Elevate a project from default-space tagging to owning a
    dedicated space — see
    `docs/plans/2026-05-27-per-project-memory-scoping-design.md` §6.

    XOR validation:
      `(space_id is None) == (embedding_model is None)` is True when
      both are None OR both are set — either case is ambiguous and
      rejected here, BEFORE delegating to the service. Pydantic alone
      cannot express XOR (no model_validator on `BaseModel.fields`
      alone) so this lives at the handler.

    Service-raised HTTPException (404 on unknown project/space, 422 on
    unknown embedding model) propagates through FastAPI unchanged.
    Commit happens here, mirroring `/ensure` and the rest of the
    engine's handler/service split.
    """
    if (body.space_id is None) == (body.embedding_model is None):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="must supply exactly one of space_id or embedding_model",
        )
    svc = ProjectService()
    project = await svc.promote(
        session,
        user_id=ctx.user_id,
        agent_id=ctx.agent_id,
        project_id=project_id,
        space_id=body.space_id,
        embedding_model=body.embedding_model,
    )
    # dedicated_space_id is non-None here: promote() either set it to
    # the supplied space_id or to the newly-created space's id, and
    # both code paths run BEFORE the early returns. The type-checker
    # sees `uuid.UUID | None` on the column so we narrow with an
    # explicit `if`-raise that doubles as a runtime invariant guard
    # — using `assert` would be stripped under `python -O`, which is
    # the production runtime mode, so a future refactor that leaves
    # the column None would silently produce a confusing pydantic
    # error on the response. The HTTPException makes the invariant
    # violation impossible to miss.
    if project.dedicated_space_id is None:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "promote() returned a project without dedicated_space_id "
            "(internal invariant violation)",
        )
    # Audit the promotion BEFORE commit so the audit row and the
    # project mutation land in the same transaction — either both
    # persist or neither does (no torn state where the project moved
    # to a dedicated space but the audit chain has no record of it).
    # Mirrors the audit pattern in `api/spaces.py::create_space`. The
    # `mode` field disambiguates the two code paths so post-hoc audit
    # consumers can tell whether a new space was minted or an existing
    # one was reused.
    await write_audit_event(
        session,
        user_id=ctx.user_id,
        actor_type="agent",
        actor_id=ctx.agent_id,
        action="project.promote",
        target_type="project",
        target_id=project.id,
        metadata={
            "mode": (
                "existing_space" if body.space_id is not None
                else "new_space_with_embedding"
            ),
            "space_id": str(project.dedicated_space_id),
            "embedding_model": body.embedding_model,
        },
    )
    await session.commit()
    return PromoteResponse(
        project_id=project.id,
        dedicated_space_id=project.dedicated_space_id,
    )
