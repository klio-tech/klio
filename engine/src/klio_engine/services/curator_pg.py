"""Postgres-backed Curator collaborators.

These wrap the SQLAlchemy models so the Curator class stays free of
DB knowledge — handy for unit tests with fakes (test_curator.py)
and for a future REST-backed remote curator (out of scope for v1).

The Curator's `CursorStore` and `ObservationReader` Protocols are
declared in `services/curator.py`. These two classes implement them
against the engine's primary AsyncSession.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.crypto.envelope import EnvelopeEncrypter
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.models.curator_state import CuratorState
from klio_engine.models.entry import Entry, EntryKind
from klio_engine.models.user import User


@dataclass(frozen=True)
class Observation:
    """Decrypted observation handed to the Curator's `_render_transcript`.

    The Curator only needs `id`, `content`, `created_at`. We freeze the
    dataclass so a tick can pass observations around without the
    accidental-mutation footgun that comes with raw ORM rows."""

    id: uuid.UUID
    content: str
    created_at: datetime


class PgCursorStore:
    """Reads / writes per-user curator cursors via SQLAlchemy."""

    def __init__(self, *, session: AsyncSession) -> None:
        self._session = session

    async def read(self, user_id: uuid.UUID) -> datetime:
        """Return the user's high-water-mark cursor, or the epoch
        sentinel if no row exists (lazy creation)."""
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
        """Upsert the per-user state on a successful tick.

        Row absent → insert with runs_count=1.
        Row present → update last_cursor_at + clear last_error +
                      increment runs_count.
        """
        now = datetime.now(timezone.utc)
        stmt = (
            pg_insert(CuratorState)
            .values(
                user_id=user_id,
                last_run_at=now,
                last_cursor_at=new_cursor,
                runs_count=1,
                last_error=None,
                last_synthesized=synthesized,
            )
            .on_conflict_do_update(
                index_elements=["user_id"],
                set_=dict(
                    last_run_at=now,
                    last_cursor_at=new_cursor,
                    runs_count=CuratorState.runs_count + 1,
                    last_error=None,
                    last_synthesized=synthesized,
                ),
            )
        )
        await self._session.execute(stmt)

    async def write_failure(self, user_id: uuid.UUID, err: str) -> None:
        """Record a failed tick. CRITICAL: do NOT touch last_cursor_at
        on update so the next tick re-tries the same observation
        window.

        On insert (first-ever tick failed): the column's server_default
        of '1970-01-01' is used — same effective behaviour as advancing
        cursor never having moved.
        """
        now = datetime.now(timezone.utc)
        stmt = (
            pg_insert(CuratorState)
            .values(
                user_id=user_id,
                last_run_at=now,
                runs_count=1,
                last_error=err,
            )
            .on_conflict_do_update(
                index_elements=["user_id"],
                set_=dict(
                    last_run_at=now,
                    runs_count=CuratorState.runs_count + 1,
                    last_error=err,
                    # Deliberately omit last_cursor_at — preserve
                    # whatever value the row already had.
                ),
            )
        )
        await self._session.execute(stmt)


class PgObservationReader:
    """Reads recent kind=observation entries for one user.

    Returns raw `Entry` rows with encrypted `content_ciphertext`. The
    Curator's `_render_transcript` requires plaintext on `.content`, so
    a downstream consumer must decrypt before rendering — see
    `DecryptingObservationReader` for the production wiring used by
    `services.curator_scheduler`. This class stays content-agnostic so
    SQL-only tests (test_curator_pg.py) can exercise the filter and
    ordering semantics without standing up an envelope-key fixture.
    """

    def __init__(self, *, session: AsyncSession) -> None:
        self._session = session

    async def read(
        self, *, user_id: uuid.UUID, since: datetime, limit: int
    ) -> list[Entry]:
        """Returns observation entries for `user_id` whose
        created_at is strictly greater than `since`, ordered by
        created_at ASC, capped at `limit`. Other kinds are
        excluded by the SQL filter, not in Python."""
        stmt = (
            select(Entry)
            .where(Entry.user_id == user_id)
            .where(Entry.kind == EntryKind.OBSERVATION)
            .where(Entry.created_at > since)
            .order_by(Entry.created_at)
            .limit(limit)
        )
        return list((await self._session.execute(stmt)).scalars().all())


class DecryptingObservationReader:
    """Curator-facing ObservationReader that yields plaintext rows.

    Wraps `PgObservationReader` (raw encrypted Entry rows) + the user's
    envelope key (unwrapped via KMS) and returns lightweight
    `Observation` dataclasses that satisfy the Curator's contract:
    `.id`, `.content`, `.created_at`.

    Decryption is per-batch, not per-row: the envelope key is unwrapped
    once per `read` call and reused across the batch's rows. This keeps
    KMS calls bounded — at most one per tick per user — while still
    handing the Curator plaintext content for the LLM-facing transcript.
    """

    def __init__(self, *, session: AsyncSession, kms: KMSClient) -> None:
        self._inner = PgObservationReader(session=session)
        self._session = session
        self._kms = kms

    async def read(
        self, *, user_id: uuid.UUID, since: datetime, limit: int
    ) -> list[Observation]:
        rows = await self._inner.read(
            user_id=user_id, since=since, limit=limit
        )
        if not rows:
            return []
        envelope = await self._envelope_for(user_id)
        return [
            Observation(
                id=r.id,
                content=envelope.decrypt(
                    r.content_nonce, r.content_ciphertext
                ).decode("utf-8"),
                created_at=r.created_at,
            )
            for r in rows
        ]

    async def _envelope_for(self, user_id: uuid.UUID) -> EnvelopeEncrypter:
        """Unwrap the user's envelope key once per tick. Mirrors the
        helper in `EntryService._envelope` rather than reusing it
        directly to keep the curator path free of `EntryService`'s
        embedding/dedup dependencies."""
        u = await self._session.get(User, user_id)
        if u is None or u.wrapped_envelope_key is None:
            raise ValueError(
                f"user {user_id} has no envelope key — curator cannot "
                "decrypt observations without one; provision the user "
                "via services.user_keys before enabling the curator"
            )
        plaintext_key = self._kms.unwrap_envelope_key(u.wrapped_envelope_key)
        return EnvelopeEncrypter(envelope_key=plaintext_key)
