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

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.api.auth import RequestContext, require_auth
from klio_engine.dependencies import get_session
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
        project_id=project_id,
        space_id=body.space_id,
        embedding_model=body.embedding_model,
    )
    await session.commit()
    # dedicated_space_id is non-None here: promote() either set it to
    # the supplied space_id or to the newly-created space's id, and
    # both code paths run BEFORE the early returns. The type-checker
    # sees `uuid.UUID | None` on the column so we narrow with an
    # assert that doubles as a runtime invariant guard — if a future
    # refactor introduces a path that leaves it None, this fires
    # immediately instead of producing a confusing pydantic error.
    assert project.dedicated_space_id is not None
    return PromoteResponse(
        project_id=project.id,
        dedicated_space_id=project.dedicated_space_id,
    )
