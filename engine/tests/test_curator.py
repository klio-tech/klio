"""Curator unit tests — pure async, in-memory fakes.

The curator is reused-only-LLM logic glued to a cursor + scheduler.
We test the LLM glue here with a fake FactExtractor; the LLM itself
is tested in test_extractor_routing.py. The scheduler integration
test (against a real Postgres + APScheduler tick) lives in
test_curator_integration.py."""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from klio_engine.services.curator import Curator
from klio_engine.services.extractor import ExtractedEntry


# --- fakes ---------------------------------------------------------


@dataclass
class _Obs:
    """Minimal Entry-shape stand-in for the curator's read query."""
    id: uuid.UUID
    content: str
    created_at: datetime


class _FakeObservationReader:
    def __init__(self, items: list[_Obs]) -> None:
        self.items = items
        self.calls: list[tuple[uuid.UUID, datetime, int]] = []

    async def read(
        self, user_id: uuid.UUID, since: datetime, limit: int
    ) -> list[_Obs]:
        self.calls.append((user_id, since, limit))
        return [o for o in self.items if o.created_at > since][:limit]


class _FakeExtractor:
    def __init__(self, response: list[ExtractedEntry] | Exception) -> None:
        self.response = response
        self.calls: list[str] = []

    async def extract(self, transcript: str) -> list[ExtractedEntry]:
        self.calls.append(transcript)
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


class _FakeWriter:
    def __init__(self) -> None:
        self.writes: list[dict[str, Any]] = []

    async def write(self, **kwargs: Any) -> None:
        self.writes.append(kwargs)


class _FakeCursorStore:
    def __init__(self) -> None:
        self.cursors: dict[uuid.UUID, datetime] = {}
        self.last_synthesized: dict[uuid.UUID, int] = {}
        self.last_error: dict[uuid.UUID, str | None] = {}
        self.runs_count: dict[uuid.UUID, int] = {}

    async def read(self, user_id: uuid.UUID) -> datetime:
        return self.cursors.get(
            user_id, datetime(1970, 1, 1, tzinfo=timezone.utc)
        )

    async def write_success(
        self,
        user_id: uuid.UUID,
        new_cursor: datetime,
        synthesized: int,
    ) -> None:
        self.cursors[user_id] = new_cursor
        self.last_synthesized[user_id] = synthesized
        self.last_error[user_id] = None
        self.runs_count[user_id] = self.runs_count.get(user_id, 0) + 1

    async def write_failure(self, user_id: uuid.UUID, err: str) -> None:
        self.last_error[user_id] = err
        self.runs_count[user_id] = self.runs_count.get(user_id, 0) + 1


# --- tests ---------------------------------------------------------


def _ts(s: int) -> datetime:
    return datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=s)


@pytest.mark.asyncio
async def test_curator_no_observations_is_a_clean_noop() -> None:
    """An empty backlog must still record a successful tick — that's
    how operators tell the curator is alive vs. wedged."""
    user = uuid.uuid4()
    reader = _FakeObservationReader([])
    extractor = _FakeExtractor(response=[])
    writer = _FakeWriter()
    store = _FakeCursorStore()

    c = Curator(reader=reader, extractor=extractor, writer=writer, store=store)
    await c.run_once(user_id=user, batch_size=10)

    assert store.runs_count[user] == 1
    assert store.last_synthesized[user] == 0
    assert store.last_error[user] is None
    assert extractor.calls == []  # no batch → no LLM call


@pytest.mark.asyncio
async def test_curator_processes_batch_and_advances_cursor() -> None:
    user = uuid.uuid4()
    obs = [
        _Obs(id=uuid.uuid4(), content="user prefers Bun", created_at=_ts(10)),
        _Obs(id=uuid.uuid4(), content="user picked Railway", created_at=_ts(20)),
    ]
    extracted = [
        ExtractedEntry(kind="memory", content="prefers Bun", confidence=0.9),
        ExtractedEntry(kind="decision", content="deploys on Railway", confidence=0.85),
    ]
    reader = _FakeObservationReader(obs)
    extractor = _FakeExtractor(response=extracted)
    writer = _FakeWriter()
    store = _FakeCursorStore()

    c = Curator(reader=reader, extractor=extractor, writer=writer, store=store)
    await c.run_once(user_id=user, batch_size=10)

    # Cursor advanced to the latest observation's timestamp.
    assert store.cursors[user] == _ts(20)
    # Writer was called once per ExtractedEntry.
    assert len(writer.writes) == 2
    kinds = sorted(w["kind"] for w in writer.writes)
    assert kinds == ["decision", "memory"]
    # Each synthesised entry carries provenance.
    sources = writer.writes[0]["metadata"]["sources"]
    assert isinstance(sources, list) and len(sources) == 2
    assert store.last_synthesized[user] == 2
    assert store.last_error[user] is None


@pytest.mark.asyncio
async def test_curator_extractor_failure_does_not_advance_cursor() -> None:
    """LLM unreachable → record error, leave cursor untouched, do
    NOT write any entries. Next tick re-tries the same window."""
    user = uuid.uuid4()
    obs = [_Obs(id=uuid.uuid4(), content="x", created_at=_ts(10))]
    reader = _FakeObservationReader(obs)
    extractor = _FakeExtractor(response=RuntimeError("ollama unreachable"))
    writer = _FakeWriter()
    store = _FakeCursorStore()

    c = Curator(reader=reader, extractor=extractor, writer=writer, store=store)
    await c.run_once(user_id=user, batch_size=10)

    assert user not in store.cursors  # cursor untouched
    assert writer.writes == []
    assert "ollama unreachable" in (store.last_error[user] or "")
    assert store.runs_count[user] == 1


@pytest.mark.asyncio
async def test_curator_concurrent_run_for_same_user_is_a_noop() -> None:
    """Per-user lock — second invocation while the first is in flight
    must NOT issue a duplicate LLM call or duplicate writes."""
    import asyncio

    user = uuid.uuid4()
    obs = [_Obs(id=uuid.uuid4(), content="x", created_at=_ts(10))]
    reader = _FakeObservationReader(obs)

    # Slow extractor: sleeps long enough that the second run_once
    # overlaps the first.
    class _SlowExtractor:
        def __init__(self) -> None:
            self.calls = 0

        async def extract(self, transcript: str) -> list[ExtractedEntry]:
            self.calls += 1
            await asyncio.sleep(0.05)
            return [ExtractedEntry(kind="memory", content="z", confidence=1)]

    extractor = _SlowExtractor()
    writer = _FakeWriter()
    store = _FakeCursorStore()

    c = Curator(reader=reader, extractor=extractor, writer=writer, store=store)
    await asyncio.gather(
        c.run_once(user_id=user, batch_size=10),
        c.run_once(user_id=user, batch_size=10),
    )

    # Single-flight: extractor saw exactly one call, writer wrote one
    # entry, runs_count incremented once.
    assert extractor.calls == 1
    assert len(writer.writes) == 1


@pytest.mark.asyncio
async def test_curator_batch_size_limits_observation_read() -> None:
    """Backlogs drain over multiple ticks — one tick reads at most
    `batch_size` observations and stops. The next tick picks up the
    remainder."""
    user = uuid.uuid4()
    obs = [_Obs(id=uuid.uuid4(), content=f"obs-{i}", created_at=_ts(i)) for i in range(100)]
    reader = _FakeObservationReader(obs)
    extractor = _FakeExtractor(response=[])
    writer = _FakeWriter()
    store = _FakeCursorStore()

    c = Curator(reader=reader, extractor=extractor, writer=writer, store=store)
    await c.run_once(user_id=user, batch_size=25)

    # Reader was called with the bound limit.
    assert reader.calls[0][2] == 25
    # Cursor advanced to the 25th observation's timestamp, NOT the 100th.
    assert store.cursors[user] == _ts(24)


@pytest.mark.asyncio
async def test_curator_single_flight_under_high_concurrency() -> None:
    """50 concurrent run_once invocations for the same user must
    result in exactly one extract+write pass. Empirical validation
    that the per-user lock is race-free under realistic asyncio
    scheduling, not just timing luck."""
    import asyncio

    user = uuid.uuid4()
    obs = [_Obs(id=uuid.uuid4(), content="x", created_at=_ts(10))]
    reader = _FakeObservationReader(obs)

    class _SlowExtractor:
        def __init__(self) -> None:
            self.calls = 0

        async def extract(self, transcript: str) -> list[ExtractedEntry]:
            self.calls += 1
            await asyncio.sleep(0.02)
            return [ExtractedEntry(kind="memory", content="z", confidence=1)]

    extractor = _SlowExtractor()
    writer = _FakeWriter()
    store = _FakeCursorStore()

    c = Curator(reader=reader, extractor=extractor, writer=writer, store=store)
    await asyncio.gather(*(
        c.run_once(user_id=user, batch_size=10) for _ in range(50)
    ))

    assert extractor.calls == 1
    assert len(writer.writes) == 1
