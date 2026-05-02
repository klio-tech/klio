"""Shared pytest fixtures.

Strategy: a single Postgres database running via docker-compose at localhost:5433.
Each test creates a uniquely-named schema, runs against it, and drops it afterwards.
The async engine is created per-test to avoid pytest-asyncio loop-scope mismatches.
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


@pytest_asyncio.fixture
async def session() -> AsyncIterator[AsyncSession]:
    """Per-test session with a uniquely-named Postgres schema.

    The schema gets dropped on test exit. Tables are created fresh from
    SQLAlchemy metadata, so no Alembic migration is required for unit tests.
    """
    schema = f"klio_test_{uuid.uuid4().hex[:12]}"
    engine = create_async_engine(TEST_DB_URL, pool_pre_ping=True)

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
