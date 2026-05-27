"""Projects API.

POST /v1/projects/ensure is the bridge-side get-or-create endpoint.
The bridge calls it from the hook handler (E2) once per fire that has
a resolvable project key (`project.Resolve` → `(git_remote,
repo_root_path, display_name)`). The returned UUID is then attached
to the `project` field on the write paths the bridge already calls.

The endpoint is a thin shell over `ProjectService.ensure` — the heavy
lifting (remote vs path dedup, SAVEPOINT-scoped concurrent INSERT
recovery, `last_seen_at` bumps) lives in the service. This file's job
is request-shape validation, auth scoping, and committing the
transaction.

F1 will add another route to this router: POST
/v1/projects/{id}/promote — see
`docs/plans/2026-05-27-per-project-memory-scoping-design.md`.
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
