"""Curator scheduler integration — per-user APScheduler jobs.

The actual Curator class lives in services/curator.py and is DB-
agnostic. This module is the wiring that makes ticks happen on a
clock against real Postgres + the real EntryService path.

`register_user_job` is called both from build_app's lifespan (on
engine startup, for every existing user) and from the provisioning
hook (Task C2, for users created mid-uptime). Sharing one helper
keeps both call sites in lock-step on the job-id format and trigger
configuration — drift here would mean a freshly-provisioned user
gets ticked on a different cadence than an existing one.
"""
from __future__ import annotations

import uuid

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from klio_engine.config import Settings
from klio_engine.dependencies import KMSBackend
from klio_engine.services.curator import Curator
from klio_engine.services.curator_pg import (
    DecryptingObservationReader,
    PgCursorStore,
)
from klio_engine.services.curator_writer import CuratorWriter
from klio_engine.services.extractor import FactExtractor


def _job_id_for(user_id: uuid.UUID) -> str:
    """Stable, namespaced job id so the curator's jobs don't collide
    with any other scheduler users in the same process."""
    return f"curator:{user_id}"


def register_user_job(
    *,
    scheduler: AsyncIOScheduler,
    user_id: uuid.UUID,
    settings: Settings,
    session_factory: async_sessionmaker[AsyncSession],
    kms: KMSBackend,
) -> None:
    """Attach a per-user `Curator.run_once` job to `scheduler`.

    Idempotent: if a job for the same user_id already exists, this
    is a no-op. Safe to call on every engine startup over a user
    the curator has already been handling, and safe to call from
    the C2 provisioning hook for a user that — through some race —
    might already have been registered by the startup loop.

    `KMSBackend` (rather than the concrete `KMSClient`) is the type
    accepted here so the local-file dev backend is admissible. The
    curator path doesn't care which one it gets — `EntryService`
    only invokes the two methods on the Protocol.
    """
    job_id = _job_id_for(user_id)
    if scheduler.get_job(job_id) is not None:
        return  # already registered — idempotent re-entry.

    async def _tick() -> None:
        # Fresh session per tick. Long-lived sessions don't survive
        # the scheduler's hour-long idle periods cleanly: the
        # underlying connection can be reaped by the pool, the
        # transaction can be left in a bad state by a previous
        # exception, etc. Cheap to open per tick, predictable.
        async with session_factory() as session:
            try:
                reader = DecryptingObservationReader(
                    session=session, kms=kms
                )
                extractor = FactExtractor(
                    model=settings.effective_curator_model
                )
                writer = CuratorWriter(session=session, kms=kms)
                store = PgCursorStore(session=session)
                curator = Curator(
                    reader=reader,
                    extractor=extractor,
                    writer=writer,
                    store=store,
                )
                await curator.run_once(
                    user_id=user_id,
                    batch_size=settings.curator_batch_size,
                )
                await session.commit()
            except Exception:
                # Curator.run_once already records last_error on the
                # CuratorState row through write_failure; we still
                # roll back the SQL transaction so a partially-
                # written batch never lands. APScheduler will log
                # the exception via its own logger.
                await session.rollback()
                raise

    scheduler.add_job(
        _tick,
        trigger=IntervalTrigger(seconds=settings.curator_interval_secs),
        id=job_id,
        replace_existing=True,
        # APScheduler's own concurrency cap, layered on top of the
        # Curator's own per-user `asyncio.Lock`. Belt-and-suspenders:
        # the lock guards in-process re-entry inside one tick,
        # `max_instances=1` guards against the scheduler trying to
        # fire a second tick before the first has returned (which
        # can happen if a tick runs longer than the interval).
        max_instances=1,
    )
