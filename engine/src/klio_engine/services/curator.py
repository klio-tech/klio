"""Curator — periodic synthesiser of memories from observations.

Reads `kind=observation` entries written since the per-user cursor,
hands the batch to FactExtractor, writes the synthesised
memory/decision/plan/note entries back, advances the cursor.

The class is split into four collaborators (reader, extractor,
writer, store) so each can be a hermetic fake in tests. The wiring
to real Postgres + the real services lives in
`api/main.py:build_app` (scheduler registration) and
`services/curator_pg.py` (Postgres-backed adaptors)."""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any, Protocol

import structlog


logger = structlog.get_logger(__name__)


# --- Collaborators (Protocols) ---------------------------------------


class ObservationReader(Protocol):
    """Reads recent kind=observation entries for one user."""

    async def read(
        self, user_id: uuid.UUID, since: datetime, limit: int
    ) -> list[Any]:
        ...


class Extractor(Protocol):
    """Lifts durable facts from a transcript. Same shape as
    FactExtractor.extract."""

    async def extract(self, transcript: str) -> list[Any]:
        ...


class EntryWriter(Protocol):
    """Encrypted-write + audit-chain path. Same shape as
    EntryService.write but with kwargs only — the curator-side
    binding fills in space_id and agent_id."""

    async def write(self, **kwargs: Any) -> None:
        ...


class CursorStore(Protocol):
    """Per-user cursor + telemetry persistence."""

    async def read(self, user_id: uuid.UUID) -> datetime: ...
    async def write_success(
        self, user_id: uuid.UUID, new_cursor: datetime, synthesized: int
    ) -> None: ...
    async def write_failure(self, user_id: uuid.UUID, err: str) -> None: ...


# --- Curator -------------------------------------------------------


class Curator:
    """Tick-driven synthesiser. One instance per engine container.

    `run_once` is the unit of work — APScheduler calls it on the
    interval. Concurrency is per-user via `_locks`: a second tick for
    the same user while the first is in flight is a no-op (single-
    flight). Different users tick independently."""

    def __init__(
        self,
        *,
        reader: ObservationReader,
        extractor: Extractor,
        writer: EntryWriter,
        store: CursorStore,
    ) -> None:
        self._reader = reader
        self._extractor = extractor
        self._writer = writer
        self._store = store
        self._locks: dict[uuid.UUID, asyncio.Lock] = {}

    def _lock_for(self, user_id: uuid.UUID) -> asyncio.Lock:
        lock = self._locks.get(user_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[user_id] = lock
        return lock

    async def run_once(
        self, *, user_id: uuid.UUID, batch_size: int
    ) -> None:
        lock = self._lock_for(user_id)
        if lock.locked():
            logger.info(
                "curator.skip_concurrent", user_id=str(user_id)
            )
            return
        async with lock:
            await self._run_locked(user_id=user_id, batch_size=batch_size)

    async def _run_locked(
        self, *, user_id: uuid.UUID, batch_size: int
    ) -> None:
        cursor = await self._store.read(user_id)
        try:
            batch = await self._reader.read(
                user_id=user_id, since=cursor, limit=batch_size
            )
        except Exception as err:  # noqa: BLE001
            logger.exception("curator.read_failed", user_id=str(user_id))
            await self._store.write_failure(user_id, str(err))
            return

        if not batch:
            await self._store.write_success(
                user_id=user_id,
                new_cursor=cursor,
                synthesized=0,
            )
            return

        transcript = self._render_transcript(batch)
        try:
            extracted = await self._extractor.extract(transcript)
        except Exception as err:  # noqa: BLE001
            logger.exception("curator.extract_failed", user_id=str(user_id))
            await self._store.write_failure(user_id, str(err))
            return

        run_id = uuid.uuid4()
        source_ids = [str(o.id) for o in batch]
        synthesised_at = datetime.now(timezone.utc).isoformat()
        for e in extracted:
            try:
                await self._writer.write(
                    user_id=user_id,
                    kind=e.kind,
                    content=e.content,
                    confidence=e.confidence,
                    metadata={
                        "sources": source_ids,
                        "curator_run_id": str(run_id),
                        "synthesised_at": synthesised_at,
                        **(e.metadata or {}),
                    },
                )
            except Exception as err:  # noqa: BLE001
                logger.exception(
                    "curator.write_failed",
                    user_id=str(user_id),
                    kind=e.kind,
                )
                await self._store.write_failure(user_id, str(err))
                return  # leave cursor where it is; next tick re-tries

        new_cursor = max(o.created_at for o in batch)
        await self._store.write_success(
            user_id=user_id,
            new_cursor=new_cursor,
            synthesized=len(extracted),
        )

    @staticmethod
    def _render_transcript(batch: list[Any]) -> str:
        """Stitch a batch of observation entries into a single
        transcript-shaped string for FactExtractor.

        FactExtractor's prompt expects free-form text; we use a
        consistent rendering so multiple ticks produce stable input
        when tested against the regex stub backend."""
        lines = []
        for o in batch:
            ts = o.created_at.isoformat() if o.created_at else "?"
            lines.append(f"[{ts}] {o.content}")
        return "\n".join(lines)
