"""Shared pytest fixtures.

Strategy: a single Postgres database running via docker-compose at localhost:5433.
Each test creates a uniquely-named schema, runs against it, and drops it afterwards.
The async engine is created per-test to avoid pytest-asyncio loop-scope mismatches.

Safety: every connection that this module hands out is gated on the
`_refuse_if_production_db` guardrail. The 0.5.3 incident wiped ~29 real
users / 1304 entries because a test fixture ran `TRUNCATE public.users
CASCADE` against the user's production Postgres while trying to clean
up "stale test data". The guardrail makes that physically impossible —
if the configured DB looks production-shaped (more than
`_PRODUCTION_USERS_THRESHOLD` rows in `public.users`), the fixture
aborts the entire test run with a clear refusal before any DDL/DML
touches the database.
"""
from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator, Iterator

import boto3
import pytest
import pytest_asyncio
from moto import mock_aws
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from klio_engine.crypto.kms_client import KMSClient
from klio_engine.models import Base


TEST_DB_URL = os.getenv(
    "KLIO_TEST_DATABASE_URL",
    "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio",
)

# Threshold above which `public.users` is presumed to be production
# data. Pytest fixtures occasionally leave 1-3 stale rows between runs
# in a real test DB (cleanup races, interrupted runs); 5 is generous
# headroom for that while still catching anything an order of magnitude
# beyond a clean test DB. The 0.5.3 incident DB had ~29 real users —
# this trips at 6.
_PRODUCTION_USERS_THRESHOLD = 5


async def _refuse_if_production_db(engine: AsyncEngine) -> None:
    """Guardrail: refuse to run tests against any database whose
    `public.users` table already contains more rows than a clean test
    DB ever legitimately would.

    The 0.5.3 incident: a test setup TRUNCATEd `public.users` against
    the user's prod Postgres, CASCADE'ing through 1304 entries of
    accumulated history. This check makes that physically impossible
    — the fixture aborts the whole test run with a clear refusal
    before any DDL/DML lands.

    Behaviour:
    - Fresh DB (no `public.users` table yet): safe, return.
    - `public.users` exists with ≤ threshold rows: safe, return.
    - `public.users` exists with > threshold rows: raise RuntimeError.

    The threshold is intentionally generous (see
    `_PRODUCTION_USERS_THRESHOLD`). If anyone in the future loosens or
    removes this check, `tests/test_conftest_guardrail.py` will fail —
    making the bug self-defending.
    """
    async with engine.begin() as conn:
        # `to_regclass('users')` (UNQUALIFIED) resolves via the
        # connection's `search_path`. Production callers default to
        # `search_path=public` so this hits `public.users`. Tests run
        # with `search_path=<isolated_schema>` so this hits the
        # per-test schema's users (empty unless deliberately seeded
        # by a guardrail-self-test). A qualified `public.users`
        # lookup would short-circuit search_path resolution and
        # break the guardrail's own self-tests.
        exists_row = await conn.execute(
            text("SELECT to_regclass('users') IS NOT NULL")
        )
        if not exists_row.scalar():
            return
        n = (
            await conn.execute(text("SELECT count(*) FROM users"))
        ).scalar() or 0
        if n > _PRODUCTION_USERS_THRESHOLD:
            raise RuntimeError(
                f"Refusing to run tests against a database that already "
                f"has {n} users in the `users` table. This is almost "
                f"certainly the user's production DB — running tests "
                f"against it would TRUNCATE/CASCADE through their real "
                f"data. Set KLIO_TEST_DATABASE_URL to a dedicated test "
                f"DB (a fresh `klio` Postgres on a different port and "
                f"volume), and confirm with "
                f"`SELECT count(*) FROM users` returns "
                f"<= {_PRODUCTION_USERS_THRESHOLD} before re-running "
                f"pytest."
            )


@pytest_asyncio.fixture
async def session() -> AsyncIterator[AsyncSession]:
    """Per-test session with a uniquely-named Postgres schema.

    The schema gets dropped on test exit. Tables are created fresh from
    SQLAlchemy metadata, so no Alembic migration is required for unit tests.
    """
    schema = f"klio_test_{uuid.uuid4().hex[:12]}"
    engine = create_async_engine(TEST_DB_URL, pool_pre_ping=True)

    # MUST run before any DDL on the configured DB. If this raises,
    # the fixture exits before CREATE SCHEMA / DROP SCHEMA fire.
    await _refuse_if_production_db(engine)

    try:
        async with engine.begin() as conn:
            await conn.execute(text(f'CREATE SCHEMA "{schema}"'))
            await conn.execute(text(f'SET search_path TO "{schema}", public'))
            await conn.run_sync(Base.metadata.create_all)

        SessionMaker = async_sessionmaker(engine, expire_on_commit=False)
        async with SessionMaker() as s:
            await s.execute(text(f'SET search_path TO "{schema}", public'))
            yield s
            await s.rollback()
    finally:
        async with engine.begin() as conn:
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        await engine.dispose()


@pytest.fixture
def mock_kms() -> Iterator[KMSClient]:
    """Yields a KMSClient bound to a freshly-created moto KMS key."""
    with mock_aws():
        client = boto3.client("kms", region_name="us-east-1")
        arn = client.create_key()["KeyMetadata"]["Arn"]
        yield KMSClient(key_arn=arn, region="us-east-1")
