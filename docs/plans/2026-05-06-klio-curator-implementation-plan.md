# Klio Curator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development if same-session) to implement this plan task-by-task.

**Goal:** Ship a background async job inside `klio-engine` that, on a schedule, reads recent `kind=observation` entries, runs them through the existing `FactExtractor`, and writes synthesised `memory` / `decision` / `plan` / `note` entries back — surfaced in `klio init` as a single Y/n prompt and reconfigurable via a new `klio update` subcommand.

**Architecture:** APScheduler async job inside the existing engine container's FastAPI lifespan. Reuses `services/extractor.py:FactExtractor` for classification, `services/embeddings.py` for embedding, `services/entries.py:EntryService.write` for the encrypted-write + audit-chain path. One new table (`curator_state`) for the per-user cursor; no changes to `entries`, `audit_log`, or any existing schema. `klio update` is a new top-level npm subcommand that re-prompts a slice of init and restarts only the affected container.

**Tech Stack:** Python 3.12 / FastAPI / SQLAlchemy / asyncpg / Alembic / APScheduler 3.x · TypeScript 5 / Node 20 / vitest-style `node:test` · pgvector / Postgres 16 · Docker Compose.

**Companion design doc:** `docs/plans/2026-05-06-klio-curator-design.md` — read it first for the *why*. This plan is the *how*.

---

## Conventions

- Every task is **TDD**: write the failing test → run it (red) → write the minimal code → run it (green) → commit.
- **One commit per task.** Conventional-commit message: `feat(curator): …` for engine, `feat(npm): …` for npm CLI, `chore: …` for deps / version bumps, `docs: …` for README / CHANGELOG.
- **Do NOT push to GitHub** until the user explicitly approves at Section G Step 4.
- **All file paths are absolute relative to the repo root** (`/Users/thakurg/Me/klio`). Engine paths start with `engine/`, npm paths with `npm/`.
- Any test that needs a Postgres connects to the existing dev DB at `127.0.0.1:5433` — see `engine/tests/conftest.py`. Tests that don't need a DB stay pure-python and run in `~1s`.
- Engine tests use `uv run pytest <path> -v`. Npm tests use `npm test` from `npm/`.

---

# Section A — Engine foundations (schema, deps, settings)

## Task A1: Add APScheduler dependency

**Files:**
- Modify: `engine/pyproject.toml` (dependencies array)

**Step 1: Add the dep**

In `engine/pyproject.toml`, inside the `dependencies` array, add this line after `"redis>=5",`:

```toml
    "apscheduler>=3.10",
```

`apscheduler` 3.x has a clean `AsyncIOScheduler` that integrates with FastAPI's lifespan. Avoid 4.x for now — its data-store API is still stabilising and adds Postgres-side state we don't need (we own the cursor in our own table).

**Step 2: Verify install**

```bash
cd engine && uv sync 2>&1 | tail -3
```

Expected: `Resolved` line mentioning `apscheduler`. If it errors, `uv lock --upgrade-package apscheduler` then retry.

**Step 3: Smoke import test**

Create `engine/tests/test_curator_smoke.py`:

```python
"""Smoke test that APScheduler is importable.

This exists to catch a missing dependency at PR-merge time rather than
at engine startup in production. The full curator suite below uses a
hand-rolled fake scheduler so the rest of the tests don't depend on
APScheduler internals."""
from __future__ import annotations

def test_apscheduler_is_importable() -> None:
    from apscheduler.schedulers.asyncio import AsyncIOScheduler  # noqa: F401
    from apscheduler.triggers.interval import IntervalTrigger  # noqa: F401
```

**Step 4: Run**

```bash
cd engine && uv run pytest tests/test_curator_smoke.py -v
```

Expected: `1 passed`.

**Step 5: Commit**

```bash
git add engine/pyproject.toml engine/uv.lock engine/tests/test_curator_smoke.py
git commit -m "chore(engine): add apscheduler dependency for the curator"
```

---

## Task A2: Add curator settings fields

**Files:**
- Modify: `engine/src/klio_engine/config.py` — add four fields to `Settings`
- Test: `engine/tests/test_curator_config.py` (new)

**Step 1: Write failing tests**

Create `engine/tests/test_curator_config.py`:

```python
"""Curator config — env-var → Settings round-trip.

Defaults match what the npm CLI writes into `~/.klio/.env`. The
inheritance from `extraction_model` when `curator_model` is blank is
the contract that lets `klio init` ask only one question."""
from __future__ import annotations

import os
from unittest import mock

import pytest

from klio_engine.config import Settings


def test_curator_defaults_when_no_env() -> None:
    with mock.patch.dict(os.environ, {}, clear=True):
        s = Settings(database_url="postgresql+asyncpg://x")
    assert s.curator_enabled is True
    assert s.curator_interval_secs == 3600
    assert s.curator_batch_size == 50
    assert s.curator_model == ""


def test_curator_disabled_via_env() -> None:
    with mock.patch.dict(os.environ, {"KLIO_CURATOR_ENABLED": "false"}, clear=True):
        s = Settings(database_url="postgresql+asyncpg://x")
    assert s.curator_enabled is False


def test_curator_interval_via_env() -> None:
    with mock.patch.dict(
        os.environ, {"KLIO_CURATOR_INTERVAL_SECS": "14400"}, clear=True
    ):
        s = Settings(database_url="postgresql+asyncpg://x")
    assert s.curator_interval_secs == 14400


def test_curator_model_inherits_extraction_model_when_blank() -> None:
    """When KLIO_CURATOR_MODEL is unset / empty, the curator falls back
    to whatever the user picked for extraction. This is the
    one-question-during-init contract."""
    with mock.patch.dict(
        os.environ,
        {
            "KLIO_EXTRACTION_MODEL": "ollama/qwen2.5:7b-instruct",
            "KLIO_CURATOR_MODEL": "",
        },
        clear=True,
    ):
        s = Settings(database_url="postgresql+asyncpg://x")
    assert s.effective_curator_model == "ollama/qwen2.5:7b-instruct"


def test_curator_model_override_wins() -> None:
    """Power user sets a separate cheaper model for curation."""
    with mock.patch.dict(
        os.environ,
        {
            "KLIO_EXTRACTION_MODEL": "openrouter/openai/gpt-4o",
            "KLIO_CURATOR_MODEL": "openrouter/openai/gpt-4o-mini",
        },
        clear=True,
    ):
        s = Settings(database_url="postgresql+asyncpg://x")
    assert s.effective_curator_model == "openrouter/openai/gpt-4o-mini"
```

**Step 2: Run — expect FAIL**

```bash
cd engine && uv run pytest tests/test_curator_config.py -v
```

Expected: 5 failures with `AttributeError: 'Settings' object has no attribute 'curator_enabled'`.

**Step 3: Implement**

In `engine/src/klio_engine/config.py`, after the existing `extraction_model` and `ollama_api_base` fields (around line 39), add:

```python
    # ---------- Curator (v0.5.0) ----------
    # Background async job inside this container that reads recent
    # observations and synthesises memory/decision/plan/note entries
    # from them. See docs/plans/2026-05-06-klio-curator-design.md.
    #
    # Disabled-by-config (`curator_enabled=false`) skips APScheduler
    # registration in build_app's lifespan — no I/O, no DB rows.
    curator_enabled: bool = True
    # Tick interval. Default 1 hour; the npm `klio update curator`
    # picker offers 1h / 4h / 24h / on-demand-only / disable.
    curator_interval_secs: int = 3600
    # Empty string means "fall back to extraction_model". The
    # `effective_curator_model` property below resolves the fallback
    # so call sites don't have to.
    curator_model: str = ""
    # How many observations the curator hands to FactExtractor per
    # tick. Capped to keep LLM context reasonable; oversized backlogs
    # drain over multiple ticks.
    curator_batch_size: int = 50

    @property
    def effective_curator_model(self) -> str:
        """Resolve `curator_model` against the extraction-model
        fallback. Empty string → use the user's extraction model so
        `klio init` only has to ask the model question once."""
        return self.curator_model or self.extraction_model
```

**Step 4: Run — expect PASS**

```bash
cd engine && uv run pytest tests/test_curator_config.py -v
```

Expected: `5 passed`.

**Step 5: Commit**

```bash
git add engine/src/klio_engine/config.py engine/tests/test_curator_config.py
git commit -m "feat(curator): settings fields with extraction-model fallback"
```

---

## Task A3: Add `curator_state` SQLAlchemy model

**Files:**
- Create: `engine/src/klio_engine/models/curator_state.py`
- Modify: `engine/src/klio_engine/models/__init__.py` (re-export)
- Test: `engine/tests/models/test_curator_state.py` (new)

**Step 1: Write failing test**

Create `engine/tests/models/test_curator_state.py`:

```python
"""CuratorState model — column shape + defaults.

DB-backed insert / read tests live in test_curator_integration.py.
This file is pure-python and only checks the SQLAlchemy mapping."""
from __future__ import annotations

from datetime import datetime, timezone

from klio_engine.models.curator_state import CuratorState


def test_model_has_expected_columns() -> None:
    cols = {c.name for c in CuratorState.__table__.columns}
    assert cols == {
        "user_id",
        "last_run_at",
        "last_cursor_at",
        "runs_count",
        "last_error",
        "last_synthesized",
    }


def test_user_id_is_primary_key() -> None:
    pk = [c.name for c in CuratorState.__table__.primary_key]
    assert pk == ["user_id"]


def test_runs_count_default_is_zero() -> None:
    col = CuratorState.__table__.columns["runs_count"]
    # SQLAlchemy stores the Python-level default in `default.arg` for
    # scalar defaults.
    assert col.default.arg == 0


def test_last_synthesized_default_is_zero() -> None:
    col = CuratorState.__table__.columns["last_synthesized"]
    assert col.default.arg == 0


def test_last_cursor_at_has_epoch_default() -> None:
    """Default '1970-01-01' so a brand-new user picks up every
    observation they own on the first tick. The migration sets the
    server-side default; this test pins the SQLAlchemy mapping."""
    col = CuratorState.__table__.columns["last_cursor_at"]
    assert col.server_default is not None
```

Also create `engine/tests/models/__init__.py` if it doesn't exist (the existing `models/` test dir already has a `test_models.py` so this is a no-op in practice — verify with `ls engine/tests/models/`).

**Step 2: Run — expect FAIL**

```bash
cd engine && uv run pytest tests/models/test_curator_state.py -v
```

Expected: `ImportError: cannot import name 'CuratorState'`.

**Step 3: Implement model**

Create `engine/src/klio_engine/models/curator_state.py`:

```python
"""CuratorState — per-user cursor for the background curator.

One row per user, created lazily on the first curator tick for that
user. The row is the source of truth for "what observations have
already been processed" — its `last_cursor_at` advances only after
the synthesised entries commit.

See docs/plans/2026-05-06-klio-curator-design.md for the full
semantics, including failure modes (cursor stays put on LLM
unreachable, advances only on transactional success)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from klio_engine.models.base import Base


class CuratorState(Base):
    __tablename__ = "curator_state"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    # Wall-clock of the most recent tick attempt (success or failure).
    # Surfaces in `klio status` as "last run Nm ago".
    last_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # High-water mark on `entries.created_at` for kind=observation.
    # The next tick reads strictly-greater-than this value.
    last_cursor_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("'1970-01-01 00:00:00+00'::timestamptz"),
    )
    runs_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_synthesized: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
```

In `engine/src/klio_engine/models/__init__.py`, add the import (preserve alphabetical order with the existing imports):

```python
from klio_engine.models.curator_state import CuratorState  # noqa: F401
```

**Step 4: Run — expect PASS**

```bash
cd engine && uv run pytest tests/models/test_curator_state.py -v
```

Expected: `5 passed`.

**Step 5: Commit**

```bash
git add engine/src/klio_engine/models/curator_state.py engine/src/klio_engine/models/__init__.py engine/tests/models/test_curator_state.py
git commit -m "feat(curator): CuratorState SQLAlchemy model"
```

---

## Task A4: Alembic migration for `curator_state`

**Files:**
- Create: `engine/alembic/versions/0006_curator_state.py`
- Test: smoke-run the migration against the dev DB.

**Step 1: Generate the migration body**

Look at `engine/alembic/versions/0005_per_space_embedding.py` for the existing style. Create `engine/alembic/versions/0006_curator_state.py`:

```python
"""curator_state — per-user cursor for the background curator.

The curator (v0.5.0) reads kind=observation entries since this
cursor's `last_cursor_at` and synthesises memory/decision/plan/note
entries from them. The cursor advances only on a successful batch
commit. See docs/plans/2026-05-06-klio-curator-design.md.

Per-user lazy creation: this migration creates the table empty.
The first tick for each user inserts that user's row; we don't
backfill rows for existing users because the default
`last_cursor_at = '1970-01-01'` already produces correct behaviour
on the first read (process every observation the user owns).
"""
from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa
from alembic import op


revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "curator_state",
        sa.Column(
            "user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "last_cursor_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("'1970-01-01 00:00:00+00'::timestamptz"),
        ),
        sa.Column(
            "runs_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column(
            "last_synthesized",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )


def downgrade() -> None:
    op.drop_table("curator_state")
```

**Step 2: Run migration against dev DB**

```bash
cd engine && KLIO_DATABASE_URL=postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio uv run alembic upgrade head 2>&1 | tail -5
```

Expected: `INFO  [alembic.runtime.migration] Running upgrade 0005 -> 0006, curator_state`.

**Step 3: Verify table exists**

```bash
docker exec -it $(docker ps -qf name=postgres) psql -U klio -d klio -c "\d curator_state" 2>&1 | head -15
```

Expected: column listing matching the model.

**Step 4: Smoke-test downgrade then re-upgrade**

```bash
cd engine && KLIO_DATABASE_URL=postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio uv run alembic downgrade -1 2>&1 | tail -3
cd engine && KLIO_DATABASE_URL=postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio uv run alembic upgrade head 2>&1 | tail -3
```

Expected: clean down + clean re-up.

**Step 5: Commit**

```bash
git add engine/alembic/versions/0006_curator_state.py
git commit -m "feat(curator): alembic 0006 — curator_state table"
```

---

# Section B — Engine: the Curator service

## Task B1: Curator class skeleton + cursor read

**Files:**
- Create: `engine/src/klio_engine/services/curator.py`
- Test: `engine/tests/test_curator.py` (new)

**Step 1: Write failing tests**

Create `engine/tests/test_curator.py`:

```python
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
```

**Step 2: Run — expect FAIL**

```bash
cd engine && uv run pytest tests/test_curator.py -v
```

Expected: `ImportError: cannot import name 'Curator'`.

**Step 3: Implement Curator**

Create `engine/src/klio_engine/services/curator.py`:

```python
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
```

**Step 4: Run — expect PASS**

```bash
cd engine && uv run pytest tests/test_curator.py -v
```

Expected: `5 passed`.

**Step 5: Commit**

```bash
git add engine/src/klio_engine/services/curator.py engine/tests/test_curator.py
git commit -m "feat(curator): Curator service with per-user single-flight lock"
```

---

## Task B2: Postgres-backed adaptors

**Files:**
- Create: `engine/src/klio_engine/services/curator_pg.py`
- Test: `engine/tests/test_curator_pg.py` (DB-backed; mark `pytest.mark.skipif` on `KLIO_TEST_DB_URL` not set, like `test_api_engine.py`).

**Step 1: Write failing test**

Create `engine/tests/test_curator_pg.py`:

```python
"""Postgres-backed curator collaborators — round-trip tests.

The Curator class itself is fully tested with fakes in
test_curator.py. This file pins the SQL behaviour:
  - cursor read/write
  - observation read filters by user + kind + > cursor
  - error path writes last_error without touching last_cursor_at
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import select

from klio_engine.models.curator_state import CuratorState
from klio_engine.services.curator_pg import (
    PgCursorStore,
    PgObservationReader,
)


pytestmark = pytest.mark.asyncio


async def test_cursor_read_lazy_initial_value(db_session) -> None:
    """First read for a user returns the epoch default; no row is
    inserted yet (lazy)."""
    store = PgCursorStore(session=db_session)
    user_id = uuid.uuid4()
    cursor = await store.read(user_id)
    assert cursor == datetime(1970, 1, 1, tzinfo=timezone.utc)

    rows = (await db_session.execute(select(CuratorState))).scalars().all()
    assert all(r.user_id != user_id for r in rows)


async def test_cursor_write_success_creates_row(db_session, seed_user) -> None:
    store = PgCursorStore(session=db_session)
    new_at = datetime.now(timezone.utc)
    await store.write_success(
        user_id=seed_user, new_cursor=new_at, synthesized=3
    )
    await db_session.commit()

    row = (
        await db_session.execute(
            select(CuratorState).where(CuratorState.user_id == seed_user)
        )
    ).scalar_one()
    assert row.last_cursor_at == new_at
    assert row.last_synthesized == 3
    assert row.runs_count == 1
    assert row.last_error is None


async def test_cursor_write_failure_does_not_advance_cursor(
    db_session, seed_user
) -> None:
    store = PgCursorStore(session=db_session)
    # First do a successful write so we have a non-default cursor.
    success_at = datetime.now(timezone.utc) - timedelta(minutes=10)
    await store.write_success(
        user_id=seed_user, new_cursor=success_at, synthesized=1
    )
    await db_session.commit()

    # Failure must NOT touch last_cursor_at.
    await store.write_failure(seed_user, "ollama unreachable")
    await db_session.commit()

    row = (
        await db_session.execute(
            select(CuratorState).where(CuratorState.user_id == seed_user)
        )
    ).scalar_one()
    assert row.last_cursor_at == success_at  # unchanged
    assert row.last_error == "ollama unreachable"
    assert row.runs_count == 2  # incremented on both success + failure


async def test_observation_reader_filters_by_user_kind_and_cursor(
    db_session, seed_user, seed_observations
) -> None:
    """seed_observations seeds 5 obs for seed_user + 2 obs for a
    different user. The reader must return only the seed_user's, in
    created_at order, strictly greater than the cursor."""
    reader = PgObservationReader(session=db_session)
    cursor = datetime(1970, 1, 1, tzinfo=timezone.utc)
    rows = await reader.read(user_id=seed_user, since=cursor, limit=10)
    assert len(rows) == 5
    times = [r.created_at for r in rows]
    assert times == sorted(times)
```

The `seed_observations` fixture goes in `engine/tests/conftest.py` — it needs to insert observation entries for both users. Add it:

```python
# in engine/tests/conftest.py, alongside existing fixtures:

@pytest_asyncio.fixture
async def seed_observations(db_session, seed_user):
    """Insert 5 observations for seed_user and 2 for another user.

    Used by curator tests to verify the per-user filter works."""
    from datetime import datetime, timedelta, timezone
    import uuid
    from klio_engine.models.entry import Entry, EntryKind
    from klio_engine.models.space import Space
    from klio_engine.models.agent import Agent

    base = datetime.now(timezone.utc) - timedelta(hours=1)
    # Borrow the user's default space + agent if they exist; else
    # create minimal ones.
    space = (await db_session.execute(
        select(Space).where(Space.user_id == seed_user).limit(1)
    )).scalar_one_or_none()
    if space is None:
        space = Space(
            user_id=seed_user,
            name="default",
            embedding_model="stub",
            embedding_dim=1536,
        )
        db_session.add(space)
        await db_session.flush()
    agent = (await db_session.execute(
        select(Agent).where(Agent.user_id == seed_user).limit(1)
    )).scalar_one_or_none()
    if agent is None:
        agent = Agent(user_id=seed_user, name="test-agent")
        db_session.add(agent)
        await db_session.flush()

    for i in range(5):
        db_session.add(Entry(
            user_id=seed_user,
            space_id=space.id,
            agent_id=agent.id,
            kind=EntryKind.OBSERVATION,
            ciphertext_nonce=b"\x00" * 12,
            ciphertext=b"obs",
            created_at=base + timedelta(minutes=i),
        ))
    other_user = uuid.uuid4()
    # …minimal seed for other_user omitted — actual tests should use
    # an existing 'other_user' fixture pattern from test_api_engine.py.
    await db_session.commit()
    yield
```

(If `conftest.py` already exposes a multi-user fixture, prefer that.)

**Step 2: Run — expect FAIL**

```bash
cd engine && uv run pytest tests/test_curator_pg.py -v
```

Expected: `ImportError: cannot import name 'PgCursorStore'`.

**Step 3: Implement adaptors**

Create `engine/src/klio_engine/services/curator_pg.py`:

```python
"""Postgres-backed Curator collaborators.

These wrap the SQLAlchemy models so the Curator class stays free of
DB knowledge — handy for unit tests with fakes (test_curator.py)
and for a future REST-backed remote curator (out of scope for v1).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.curator_state import CuratorState
from klio_engine.models.entry import Entry, EntryKind


class PgCursorStore:
    """Reads / writes per-user curator cursors via SQLAlchemy."""

    def __init__(self, *, session: AsyncSession) -> None:
        self._session = session

    async def read(self, user_id: uuid.UUID) -> datetime:
        row = (
            await self._session.execute(
                select(CuratorState).where(CuratorState.user_id == user_id)
            )
        ).scalar_one_or_none()
        if row is None:
            return datetime(1970, 1, 1, tzinfo=timezone.utc)
        return row.last_cursor_at

    async def write_success(
        self,
        *,
        user_id: uuid.UUID,
        new_cursor: datetime,
        synthesized: int,
    ) -> None:
        # Upsert: insert a fresh row on first write, update on subsequent.
        # `runs_count` increments via the `EXCLUDED` join in the ON CONFLICT.
        stmt = (
            pg_insert(CuratorState)
            .values(
                user_id=user_id,
                last_run_at=datetime.now(timezone.utc),
                last_cursor_at=new_cursor,
                runs_count=1,
                last_error=None,
                last_synthesized=synthesized,
            )
            .on_conflict_do_update(
                index_elements=["user_id"],
                set_=dict(
                    last_run_at=datetime.now(timezone.utc),
                    last_cursor_at=new_cursor,
                    runs_count=CuratorState.runs_count + 1,
                    last_error=None,
                    last_synthesized=synthesized,
                ),
            )
        )
        await self._session.execute(stmt)

    async def write_failure(self, user_id: uuid.UUID, err: str) -> None:
        # Like write_success but cursor stays put. Insert path uses
        # the epoch default; update path leaves last_cursor_at alone.
        stmt = (
            pg_insert(CuratorState)
            .values(
                user_id=user_id,
                last_run_at=datetime.now(timezone.utc),
                runs_count=1,
                last_error=err,
            )
            .on_conflict_do_update(
                index_elements=["user_id"],
                set_=dict(
                    last_run_at=datetime.now(timezone.utc),
                    runs_count=CuratorState.runs_count + 1,
                    last_error=err,
                ),
            )
        )
        await self._session.execute(stmt)


class PgObservationReader:
    """Reads recent kind=observation entries for one user."""

    def __init__(self, *, session: AsyncSession) -> None:
        self._session = session

    async def read(
        self, *, user_id: uuid.UUID, since: datetime, limit: int
    ) -> list[Entry]:
        stmt = (
            select(Entry)
            .where(Entry.user_id == user_id)
            .where(Entry.kind == EntryKind.OBSERVATION)
            .where(Entry.created_at > since)
            .order_by(Entry.created_at)
            .limit(limit)
        )
        return list((await self._session.execute(stmt)).scalars().all())
```

**Step 4: Run — expect PASS**

```bash
cd engine && uv run pytest tests/test_curator_pg.py -v
```

Expected: `4 passed` (skip if no test DB).

**Step 5: Commit**

```bash
git add engine/src/klio_engine/services/curator_pg.py engine/tests/test_curator_pg.py engine/tests/conftest.py
git commit -m "feat(curator): Postgres-backed cursor + observation reader"
```

---

## Task B3: EntryService adaptor for the curator's writer

**Files:**
- Modify: `engine/src/klio_engine/services/curator.py` — none yet
- Create: `engine/src/klio_engine/services/curator_writer.py`
- Test: `engine/tests/test_curator_writer.py` (DB-backed)

**Step 1: Write failing test**

Create `engine/tests/test_curator_writer.py`:

```python
"""CuratorWriter — adapts the curator's flat kwargs to EntryService.write.

The curator doesn't know about spaces or agents — it just emits
ExtractedEntry-flavoured rows. The writer pins them to the user's
default space and an agent identity tagged "klio-curator" so
synthesised entries are visibly distinct in `klio status` and the
trust-app timeline."""
from __future__ import annotations

import pytest
from sqlalchemy import select

from klio_engine.models.entry import Entry, EntryKind
from klio_engine.services.curator_writer import CuratorWriter


pytestmark = pytest.mark.asyncio


async def test_writer_pins_to_user_default_space_and_curator_agent(
    db_session, seed_user
) -> None:
    """Synthesised entries land in the user's default space, and use
    a deterministic curator-flavoured agent identity. Re-using the
    same agent across runs keeps `recall` filters predictable."""
    writer = CuratorWriter(session=db_session)
    await writer.write(
        user_id=seed_user,
        kind="memory",
        content="user prefers Bun over Node",
        confidence=0.9,
        metadata={"sources": ["x", "y"], "curator_run_id": "z"},
    )
    await db_session.commit()

    row = (
        await db_session.execute(
            select(Entry).where(Entry.user_id == seed_user)
        )
    ).scalars().all()[-1]
    assert row.kind == EntryKind.MEMORY
    # The agent name is "klio-curator" — actual id check by joining
    # to the agents table.
```

**Step 2: Run — expect FAIL**

(Skipped for brevity — the import will fail.)

**Step 3: Implement writer**

Create `engine/src/klio_engine/services/curator_writer.py`:

```python
"""CuratorWriter — bridges the curator's kwargs-only Writer protocol
to EntryService.write, resolving the user's default space and
ensuring a deterministic 'klio-curator' agent exists for provenance."""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.crypto.kms_client import LocalFileKMS  # or whatever the engine uses
from klio_engine.models.agent import Agent
from klio_engine.models.entry import EntryKind
from klio_engine.models.space import Space
from klio_engine.services.entries import EntryService


_CURATOR_AGENT_NAME = "klio-curator"


class CuratorWriter:
    def __init__(self, *, session: AsyncSession) -> None:
        self._session = session
        # EntryService construction: re-use whatever DI the API path
        # uses — see api/entries.py:_entry_service.
        self._entry_service = EntryService(
            kms=LocalFileKMS(),  # adjust to the actual constructor used
        )

    async def write(self, **kwargs: Any) -> None:
        user_id: uuid.UUID = kwargs["user_id"]
        space_id = await self._default_space_id(user_id)
        agent_id = await self._curator_agent_id(user_id)
        await self._entry_service.write(
            self._session,
            user_id=user_id,
            space_id=space_id,
            agent_id=agent_id,
            kind=EntryKind(kwargs["kind"]),
            content=kwargs["content"],
            metadata=kwargs.get("metadata"),
            confidence=kwargs.get("confidence", 1.0),
        )

    async def _default_space_id(self, user_id: uuid.UUID) -> uuid.UUID:
        space = (await self._session.execute(
            select(Space)
            .where(Space.user_id == user_id)
            .where(Space.name == "default")
        )).scalar_one()
        return space.id

    async def _curator_agent_id(self, user_id: uuid.UUID) -> uuid.UUID:
        agent = (await self._session.execute(
            select(Agent)
            .where(Agent.user_id == user_id)
            .where(Agent.name == _CURATOR_AGENT_NAME)
        )).scalar_one_or_none()
        if agent is None:
            agent = Agent(user_id=user_id, name=_CURATOR_AGENT_NAME)
            self._session.add(agent)
            await self._session.flush()
        return agent.id
```

**Step 4: Run — expect PASS**

```bash
cd engine && uv run pytest tests/test_curator_writer.py -v
```

**Step 5: Commit**

```bash
git add engine/src/klio_engine/services/curator_writer.py engine/tests/test_curator_writer.py
git commit -m "feat(curator): writer that pins to default space + klio-curator agent"
```

---

# Section C — Engine: scheduler integration

## Task C1: APScheduler lifespan in `build_app`

**Files:**
- Modify: `engine/src/klio_engine/api/main.py` — add a `@asynccontextmanager` lifespan that starts/stops the scheduler.
- Test: `engine/tests/test_curator_lifespan.py` (smoke).

(See full task body in the design — pattern: register `AsyncIOScheduler`, schedule `Curator.run_once` per user every `curator_interval_secs` if `curator_enabled`, await `scheduler.shutdown()` on exit.)

**Test:** assert that with `curator_enabled=False`, the FastAPI startup hook does NOT register a job; with `curator_enabled=True`, it does, and the scheduler stops cleanly on shutdown.

**Commit:** `feat(curator): wire scheduler into FastAPI lifespan`.

---

## Task C2: Per-user job registration on user provisioning

**Files:**
- Modify: `engine/src/klio_engine/services/provisioning.py` — after a new user is provisioned, register their curator job with the running scheduler.
- Test: `engine/tests/test_curator_provisioning.py`.

**Why:** v1 curator runs per-user. New user signups must register their job at provisioning time, not just at engine startup, otherwise users created mid-uptime never get curated.

**Test:** seed a new user via the provisioning service, assert the scheduler has a job tagged with the new `user_id`.

**Commit:** `feat(curator): register per-user job on provisioning`.

---

## Task C3: End-to-end integration test

**Files:**
- Create: `engine/tests/test_curator_integration.py` (DB-backed).

**Test outline:**

1. Seed user, default space, agent.
2. Insert 10 fake observations (`kind=observation`) for the user.
3. Construct a real `Curator` with `PgObservationReader`, `FactExtractor(model="stub")`, `CuratorWriter`, `PgCursorStore`.
4. Call `await curator.run_once(user_id=..., batch_size=20)`.
5. Assert: ≥1 entry of kind=memory exists, cursor advanced to the latest observation's `created_at`, `last_synthesized > 0`, `last_error is None`.

**Commit:** `test(curator): end-to-end integration with stub extractor`.

---

# Section D — npm CLI: init Phase 6

## Task D1: Curator config helper module

**Files:**
- Create: `npm/src/curatorConfig.ts` — pure-typescript helper that turns a `{enabled, intervalSecs, model}` object into env-block lines for the compose env file.
- Test: `npm/tests/curatorConfig.test.ts`.

**Test:** unit-cover the cadence labels (1h / 4h / 24h / on-demand-only / disabled), assert the env-block emits `KLIO_CURATOR_ENABLED`, `KLIO_CURATOR_INTERVAL_SECS`, `KLIO_CURATOR_MODEL` with the right values.

**Commit:** `feat(npm): curator config helper module`.

---

## Task D2: Phase 6 prompt in `init.ts`

**Files:**
- Modify: `npm/src/commands/init.ts` — add a Phase 6 block between agent-wiring and the wow-moment.
- Modify: `npm/src/compose.ts` — add the three new env lines to the engine service block.
- Test: `npm/tests/init.test.ts` — assert the new phase fires with default Y, that No skips it cleanly, that the env file gains the new lines.

**Failing test cases:**

- A scripted user who hits `⏎` produces `KLIO_CURATOR_ENABLED=true` in the env block.
- A scripted user who types `n` produces `KLIO_CURATOR_ENABLED=false`.
- A scripted user who types `xyz` re-prompts (covered by `askConfirm`).

**Commit:** `feat(npm): klio init phase 6 — memory curator`.

---

# Section E — npm CLI: `klio update` subcommand

## Task E1: Add `update` to the cli.ts subcommand table

**Files:**
- Modify: `npm/src/cli.ts` — append `"update"` to `SUBCOMMANDS` and route it to a new `runUpdate` handler.
- Create: `npm/src/commands/update.ts` — orchestrates the menu + dispatch.
- Test: `npm/tests/update.test.ts`.

**Test:** scripted `update` invocation with a "1" answer routes to provider re-config; "2" routes to curator; "3" routes to agents; "4" exits cleanly.

**Commit:** `feat(npm): klio update top-level subcommand`.

---

## Task E2: `update curator` block

**Files:**
- Modify: `npm/src/commands/update.ts` — implement `runUpdateCurator()`.
- Test: scripted runs that change schedule, change model, or disable.

**Behaviour:**
1. Read current `~/.klio/.env` for `KLIO_CURATOR_*` values.
2. Show "Current: every Nh, <model>" header.
3. Schedule picker (1h/4h/24h/on-demand/disable, default = current).
4. Model picker (1: same as extraction model = current, 2: pick different — re-uses provider model picker).
5. Write new env values to `~/.klio/.env`.
6. `docker compose up -d --no-deps engine` (NOT a full restart — only the engine).
7. Print "✓ Saved. Restarting engine to apply…".

**Commit:** `feat(npm): klio update curator — re-prompt schedule + model only`.

---

## Task E3: `update agents` block

**Files:**
- Modify: `npm/src/commands/update.ts` — implement `runUpdateAgents()` that re-runs the same adapter detect + wire flow init does.

**Why this is bonus value:** the user's earlier flow had the wire-tools prompt swallow memory text, leaving all six adapters un-wired. Currently the only recovery is a full `klio init`. After this task, `klio update agents` is a clean one-step recovery.

**Commit:** `feat(npm): klio update agents — re-runs adapter detection`.

---

## Task E4: `update provider` block

**Files:**
- Modify: `npm/src/commands/update.ts` — implement `runUpdateProvider()` that calls `selectProvider()` + the relevant `setupX()` from `providerSetup.ts`, writes the new env, and restarts the engine.

**Commit:** `feat(npm): klio update provider — change LLM provider without re-init`.

---

## Task E5: `--run-now` flag for `update curator`

**Files:**
- Modify: `npm/src/commands/update.ts` — after saving the curator config, if `--run-now` is in argv, hit the engine's `/v1/curator/run-now` endpoint (Task F1 below) and stream the result.

**Commit:** `feat(npm): klio update curator --run-now triggers an immediate pass`.

---

# Section F — Engine: `--run-now` endpoint

## Task F1: `POST /v1/curator/run-now` — authenticated, single-flight

**Files:**
- Create: `engine/src/klio_engine/api/curator.py` — FastAPI router.
- Modify: `engine/src/klio_engine/api/main.py` — include the router.
- Test: `engine/tests/test_api_curator.py`.

**Behaviour:**
- Auth: bearer token (existing `Depends(...)`).
- Body: empty.
- Side effect: invokes `Curator.run_once` for the authenticated user, returns 200 with `{synthesized, cursor_advanced_to, error}`.

**Commit:** `feat(curator): POST /v1/curator/run-now — on-demand trigger`.

---

# Section G — Ship 0.5.0

## Task G1: Bump npm package version + recompose tests

**Files:**
- Modify: `npm/package.json` — `"version": "0.5.0"`.
- Modify: any test asserting on `0.4.x` image tags.

**Commit:** `chore: bump @klio-tech/klio to 0.5.0`.

---

## Task G2: README + CHANGELOG

**Files:**
- Modify: `README.md` — add curator to Status table, add to Architecture diagram, add to Repository layout under `engine/src/klio_engine/services/`, mention `klio update curator` in Quick start.
- Modify: `CHANGELOG.md` (or create if missing) — 0.5.0 release notes.

**Commit:** `docs: 0.5.0 release notes — Klio Curator`.

---

## Task G3: Final code review

Spawn a code-reviewer subagent against the cumulative diff (from `git diff main...HEAD`). Address any I-/M- issues with re-review until clean. Use **superpowers:requesting-code-review**.

---

## Task G4: User approves, then push

**Do NOT push until the user explicitly approves.**

1. Run `git log --oneline main..HEAD` and present the commit list to the user with a one-line summary of each task.
2. Confirm: "Ready to push and let CI publish 0.5.0?"
3. On `yes`: `git push origin main`. CI publishes container images + npm package within ~5 min.

---

## Verification checklist (at the very end)

Before declaring done:

- [ ] `cd engine && uv run pytest tests/test_curator*.py tests/test_api_curator.py -v` → all green.
- [ ] `cd npm && npm test` → all 240+ tests green.
- [ ] `cd npm && npm run build` → typecheck clean.
- [ ] `cd trust-app && npm run typecheck` → trust-app didn't regress.
- [ ] Manual smoke: `npx @klio-tech/klio@latest init` (against the local checkout) shows Phase 6.
- [ ] Manual smoke: `klio update curator` round-trips schedule + model values.
- [ ] Manual smoke: `klio update curator --run-now` triggers a synthesized memory write that `recall` can find.
