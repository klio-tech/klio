"""Klio engine + coordinator FastAPI app.

For v0 we co-locate the engine and coordinator routers in a single FastAPI
application. They can be split into separate processes later by importing
only the relevant routers in a new entrypoint — the routers themselves don't
hold cross-state.
"""
import asyncio
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from klio_engine import __version__
from klio_engine.api.access_requests import create_router as access_create_router
from klio_engine.api.access_requests import list_router as access_list_router
from klio_engine.api.agents import agents_router, audit_router
from klio_engine.api.curator import router as curator_router
from klio_engine.api.entries import entry_delete_router
from klio_engine.api.entries import recall_router
from klio_engine.api.entries import router as entries_router
from klio_engine.api.health import router as health_router
from klio_engine.api.ingest import router as ingest_router
from klio_engine.api.projects import router as projects_router
from klio_engine.api.spaces import permissions_router
from klio_engine.api.spaces import router as spaces_router
from klio_engine.api.system import router as system_router
from klio_engine.api.users import auth_router
from klio_engine.api.users import router as users_router
from klio_engine.api.users import tokens_router
from klio_engine.config import Settings
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.crypto.local_kms import LocalFileKMSClient
from klio_engine.db import build_engine
from klio_engine.dependencies import KMSBackend
from klio_engine.models.user import User
from klio_engine.services.curator_scheduler import register_user_job


def _build_kms(settings: Settings) -> KMSBackend:
    """Resolve the KMS backend the same way `dependencies.get_kms`
    does, but for the lifespan-scoped instance owned by the
    scheduler. Kept in sync with that helper deliberately — the
    curator must use whichever KMS the rest of the engine uses for
    a given environment, otherwise envelope-key wraps would diverge.
    """
    if settings.dev_kms_path:
        return LocalFileKMSClient(settings.dev_kms_path)
    return KMSClient(key_arn=settings.kms_key_arn, region=settings.aws_region)


@asynccontextmanager
async def _curator_lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Start the curator scheduler at engine boot and stop it on
    shutdown. No-op when KLIO_CURATOR_ENABLED is False — explicitly
    no I/O, no DB rows, no scheduler thread. The flag is the kill
    switch the operator reaches for when something is wrong with
    the curator path; it must mean *nothing happens*.

    On startup, the scheduler is populated with one job per existing
    user — UNLESS `curator_interval_secs == 0`, the on-demand-only
    sentinel. In on-demand mode the scheduler still starts and the
    session_factory + kms still get stashed on `app.state` (so the
    `POST /v1/curator/run-now` endpoint and the C2 provisioning hook
    work), but no clock-driven ticks are registered.

    New users created mid-uptime get registered via the provisioning
    hook in C2 calling `register_user_job` against the same scheduler
    + session_factory + kms + lock-registry stashed on `app.state`.

    The lock-registry (`app.state.curator_locks`) is the single
    shared per-user `asyncio.Lock` table consulted by both the
    scheduled tick and the run-now HTTP handler — without sharing,
    a tick and a run-now for the same user would race and double-
    issue the LLM call over the overlapping observation window.
    """
    settings = Settings()
    if not settings.curator_enabled:
        # Disabled-by-config: yield without touching the DB or
        # spinning up any background work. The C2 provisioning hook
        # also reads `app.state` defensively (no scheduler → no
        # registration), so this is the only no-op surface needed.
        yield
        return

    scheduler = AsyncIOScheduler()
    scheduler.start()
    app.state.curator_scheduler = scheduler

    # The async engine + sessionmaker live for the lifetime of the
    # app — both startup's bootstrap loop and every subsequent tick
    # share them. `pool_pre_ping=True` (set by build_engine) makes
    # the pool resilient to long idle gaps between hourly ticks.
    engine = build_engine(settings.database_url)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    kms = _build_kms(settings)

    # Per-user lock registry shared across both invocation surfaces:
    # - the scheduler's `_tick` (via `register_user_job`)
    # - the run-now HTTP handler (via `app.state` lookup)
    # The Curator class consults this same dict for `run_once`, so
    # a scheduled tick and a manual run-now for the same user
    # serialise correctly rather than each spinning up a fresh
    # private lock and racing past each other.
    locks: dict[uuid.UUID, asyncio.Lock] = {}
    app.state.curator_locks = locks

    # Bootstrap: register one job per existing user. We only
    # enumerate non-deleted users — `deleted_at IS NULL` keeps a
    # tombstoned user's curator from waking up.
    #
    # In on-demand mode (`curator_interval_secs == 0`) the call
    # below short-circuits inside `register_user_job`, so this loop
    # is effectively a no-op — but we still iterate so the path is
    # uniform and any future per-user precondition checks live in
    # one place.
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(User.id).where(User.deleted_at.is_(None))
            )
        ).scalars().all()
        for user_id in rows:
            register_user_job(
                scheduler=scheduler,
                user_id=user_id,
                settings=settings,
                session_factory=session_factory,
                kms=kms,
                locks=locks,
            )

    # Stash the shared infrastructure so C2's provisioning hook can
    # call `register_user_job` against the same scheduler + factory
    # + kms + locks. Putting them on app.state (rather than module
    # globals) keeps the lifecycle scoped to this app instance —
    # multiple apps in the same process (test suite) don't trample
    # each other's curator state.
    app.state.curator_session_factory = session_factory
    app.state.curator_kms = kms
    app.state.curator_settings = settings

    try:
        yield
    finally:
        # `wait=True` blocks until any in-flight tick finishes.
        # That's the right call here: the engine is shutting down,
        # we want a clean drain rather than a torn write half-way
        # through the audit chain.
        scheduler.shutdown(wait=True)
        await engine.dispose()


def build_app() -> FastAPI:
    app = FastAPI(
        title="Klio",
        version=__version__,
        docs_url="/docs",
        redoc_url=None,
        lifespan=_curator_lifespan,
    )
    app.include_router(health_router)
    app.include_router(users_router)
    app.include_router(tokens_router)
    app.include_router(auth_router)
    app.include_router(spaces_router)
    app.include_router(permissions_router)
    app.include_router(entries_router)
    app.include_router(entry_delete_router)
    app.include_router(recall_router)
    app.include_router(agents_router)
    app.include_router(audit_router)
    app.include_router(ingest_router)
    app.include_router(projects_router)
    app.include_router(access_create_router)
    app.include_router(access_list_router)
    app.include_router(curator_router)
    app.include_router(system_router)
    return app


app = build_app()
