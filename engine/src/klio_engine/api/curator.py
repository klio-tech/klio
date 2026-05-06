"""Curator REST routes — `POST /v1/curator/run-now`.

Triggers an immediate Curator pass for the authenticated user. The
scheduler's interval-driven tick still fires on its own cadence; this
endpoint is a manual override for when the user wants to drain the
backlog NOW (or when the operator has chosen the on-demand-only
cadence).

The Curator's per-user `asyncio.Lock` makes concurrent run-now calls
safe — a second call while the first is in flight is a no-op. The
response carries `skipped_concurrent` so the caller could one day
surface that distinction; v1 always returns `false` (see TODO inside
the handler).

The lock registry is shared (via `app.state.curator_locks`) with the
scheduler-side Curator so a scheduled tick and a run-now for the
same user serialise correctly. Without sharing, each surface owned
its own private lock table and a tick + run-now overlap could
double-issue the LLM call over the same observation window.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.api.auth import RequestContext, require_auth
from klio_engine.config import Settings
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.dependencies import KMSBackend, get_kms, get_session
from klio_engine.models.curator_state import CuratorState
from klio_engine.services.curator import Curator
from klio_engine.services.curator_pg import (
    DecryptingObservationReader,
    PgCursorStore,
)
from klio_engine.services.curator_writer import CuratorWriter
from klio_engine.services.extractor import FactExtractor


router = APIRouter(prefix="/v1/curator", tags=["curator"])


@router.post("/run-now")
async def run_now(
    request: Request,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
    kms: KMSBackend = Depends(get_kms),
) -> dict[str, object]:
    """Run a single curator pass for the authenticated user.

    Returns 200 with `{synthesized, cursor_advanced_to, error,
    skipped_concurrent}`. Returns 503 if `KLIO_CURATOR_ENABLED=false`.
    Returns 401 (via `require_auth`) for missing / invalid tokens.

    On internal failure inside the Curator (LLM unreachable, etc.) the
    Curator's `write_failure` path records `last_error` on the
    `curator_state` row; this handler still returns 200 with that
    error string in the body so the CLI can surface it.
    """
    # Re-use the lifespan-built Settings instance when present so we
    # don't re-parse the env on every request. Falls back to a fresh
    # Settings() only when the lifespan never ran (e.g., a test that
    # skips lifespan_context entirely).
    settings = getattr(
        request.app.state, "curator_settings", None
    ) or Settings()
    if not settings.curator_enabled:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Curator is disabled — set KLIO_CURATOR_ENABLED=true to enable.",
        )

    # Same collaborator wiring as the scheduler's tick (see
    # services.curator_scheduler.register_user_job._tick).
    #
    # The KMSBackend Protocol covers both `KMSClient` (AWS) and
    # `LocalFileKMSClient` (dev). DecryptingObservationReader and
    # CuratorWriter both type their `kms` parameter as the concrete
    # `KMSClient`, but only call methods that exist on the Protocol —
    # the type narrowing here matches the rest of the engine
    # (see services/curator_scheduler.py).
    reader = DecryptingObservationReader(
        session=session, kms=kms  # type: ignore[arg-type]
    )
    extractor = FactExtractor(model=settings.effective_curator_model)
    writer = CuratorWriter(
        session=session,
        kms=kms,  # type: ignore[arg-type]
        dedup_threshold=settings.dedup_cosine_threshold,
    )
    store = PgCursorStore(session=session)
    # Pull the lifespan-shared per-user lock registry off app.state.
    # Without sharing, run-now would have its own private lock table
    # and could race against a scheduled tick for the same user
    # (the scheduler holds its lock; run-now would mint a fresh
    # empty dict, see lock-not-held, and proceed in parallel —
    # exactly the double LLM call we want to prevent).
    locks = getattr(request.app.state, "curator_locks", None)
    curator = Curator(
        reader=reader,
        extractor=extractor,
        writer=writer,
        store=store,
        locks=locks,
    )

    await curator.run_once(
        user_id=ctx.user_id, batch_size=settings.curator_batch_size
    )
    # Commit the synthesised entries + the curator_state upsert in one
    # transaction so the response we surface back is consistent with
    # what landed in Postgres.
    await session.commit()

    # Re-read the per-user state row to surface the result. `expire_all`
    # forces a fresh fetch in case SQLAlchemy returned a cached entity
    # from before the commit.
    session.expire_all()
    state = (
        await session.execute(
            select(CuratorState).where(
                CuratorState.user_id == ctx.user_id
            )
        )
    ).scalar_one_or_none()

    if state is None:
        # Defensive: the Curator always writes either a success or
        # failure row before returning. Reaching here means a code path
        # in the Curator silently returned without persisting state —
        # treat as a clean no-op rather than a 500 so the CLI doesn't
        # crash on a benign edge case.
        return {
            "synthesized": 0,
            "cursor_advanced_to": None,
            "error": None,
            # TODO: surface the actual lock-skip signal once the
            # Curator exposes "was this call skipped?" to callers. v1
            # always reports false because the lock check inside
            # `Curator.run_once` returns early without raising.
            "skipped_concurrent": False,
        }

    return {
        "synthesized": state.last_synthesized,
        "cursor_advanced_to": (
            state.last_cursor_at.isoformat()
            if state.last_cursor_at is not None
            else None
        ),
        "error": state.last_error,
        # See TODO above. Always False in v1.
        "skipped_concurrent": False,
    }
