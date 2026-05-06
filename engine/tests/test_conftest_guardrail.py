"""Self-defending tests for the production-DB guardrail.

The 0.5.3 incident: a test setup ran `TRUNCATE public.users CASCADE`
against the user's PRODUCTION Postgres while trying to clean up "stale
test data," wiping ~29 real users + 1304 entries.

The fix is `conftest._refuse_if_production_db`. These tests pin its
contract: if anyone in the future loosens or removes the check, this
file fails — making the bug self-defending.

Approach: unit-level tests against the underlying function with a
disposable schema-isolated engine. We avoid wiring an inverted autouse
fixture (the plan doc explicitly notes either approach is acceptable
and the unit-level path is less involved).
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from tests.conftest import (
    TEST_DB_URL,
    _PRODUCTION_USERS_THRESHOLD,
    _refuse_if_production_db,
)


async def _seed_users_table(engine, *, schema: str, n_rows: int) -> None:
    """Create a `public.users`-shaped table inside an isolated schema
    and seed it with `n_rows` rows.

    The guardrail looks at `public.users`, so we override `search_path`
    on the connection to point `public` at our disposable schema for
    the duration of the check. This lets each test exercise the
    threshold logic without ever touching the real `public` schema.
    """
    async with engine.begin() as conn:
        await conn.execute(text(f'CREATE SCHEMA "{schema}"'))
        await conn.execute(
            text(
                f'CREATE TABLE "{schema}".users '
                f"(id uuid PRIMARY KEY DEFAULT gen_random_uuid())"
            )
        )
        for _ in range(n_rows):
            await conn.execute(
                text(f'INSERT INTO "{schema}".users (id) VALUES (gen_random_uuid())')
            )


def _engine_with_search_path(schema: str):
    """Build an engine whose connections resolve `public.<table>` to
    `<schema>.<table>`. Done via libpq's `options=-csearch_path=...`
    so it applies to every connection — including the implicit ones
    `to_regclass('public.users')` consults inside the guardrail.
    """
    return create_async_engine(
        TEST_DB_URL,
        pool_pre_ping=True,
        connect_args={"server_settings": {"search_path": schema}},
    )


@pytest.mark.asyncio
async def test_guardrail_passes_when_users_table_does_not_exist() -> None:
    """Fresh ephemeral DB: no `users` table yet. Safe — return without
    raising. This is the path real test runs hit on a clean test DB."""
    schema = f"klio_guardrail_{uuid.uuid4().hex[:12]}"
    engine = _engine_with_search_path(schema)
    try:
        async with engine.begin() as conn:
            await conn.execute(text(f'CREATE SCHEMA "{schema}"'))
        # No users table created — guardrail must not raise.
        await _refuse_if_production_db(engine)
    finally:
        async with engine.begin() as conn:
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        await engine.dispose()


@pytest.mark.asyncio
async def test_guardrail_passes_when_users_table_at_threshold() -> None:
    """Exactly at the threshold: still safe. The threshold is
    inclusive on the safe side — pytest fixtures occasionally leave
    a few stale rows."""
    schema = f"klio_guardrail_{uuid.uuid4().hex[:12]}"
    engine = _engine_with_search_path(schema)
    try:
        await _seed_users_table(
            engine, schema=schema, n_rows=_PRODUCTION_USERS_THRESHOLD
        )
        # At threshold: must not raise.
        await _refuse_if_production_db(engine)
    finally:
        async with engine.begin() as conn:
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        await engine.dispose()


@pytest.mark.asyncio
async def test_guardrail_refuses_when_users_table_exceeds_threshold() -> None:
    """Production-shaped DB: more rows than any test run could
    legitimately leave behind. Guardrail MUST raise with a message that
    names the row count and tells the operator how to recover."""
    schema = f"klio_guardrail_{uuid.uuid4().hex[:12]}"
    engine = _engine_with_search_path(schema)
    n = _PRODUCTION_USERS_THRESHOLD + 1  # one over the line
    try:
        await _seed_users_table(engine, schema=schema, n_rows=n)
        with pytest.raises(RuntimeError) as excinfo:
            await _refuse_if_production_db(engine)
        msg = str(excinfo.value)
        assert "Refusing to run tests" in msg
        assert str(n) in msg, "error message must name the offending row count"
        assert "KLIO_TEST_DATABASE_URL" in msg, (
            "error message must point operators at the env var to fix"
        )
    finally:
        async with engine.begin() as conn:
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        await engine.dispose()


@pytest.mark.asyncio
async def test_guardrail_refuses_far_past_threshold() -> None:
    """The 0.5.3-incident-shape: ~29 users. Guardrail must refuse.
    Specific test for the historical case so a regression to a
    "round-number" threshold (e.g. someone bumping it to 50 "to be
    safe") is caught."""
    schema = f"klio_guardrail_{uuid.uuid4().hex[:12]}"
    engine = _engine_with_search_path(schema)
    try:
        await _seed_users_table(engine, schema=schema, n_rows=29)
        with pytest.raises(RuntimeError, match="Refusing to run tests"):
            await _refuse_if_production_db(engine)
    finally:
        async with engine.begin() as conn:
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        await engine.dispose()
