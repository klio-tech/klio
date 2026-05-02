"""FastAPI dependency injection."""
from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from klio_engine.config import Settings
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.db import build_engine


_engine: AsyncEngine | None = None
_factory: async_sessionmaker[AsyncSession] | None = None


def _settings() -> Settings:
    return Settings()


def _ensure_factory() -> async_sessionmaker[AsyncSession]:
    global _engine, _factory
    if _factory is None:
        _engine = build_engine(str(_settings().database_url))
        _factory = async_sessionmaker(_engine, expire_on_commit=False)
    return _factory


async def get_session() -> AsyncIterator[AsyncSession]:
    factory = _ensure_factory()
    async with factory() as s:
        yield s


def get_kms() -> KMSClient:
    s = _settings()
    return KMSClient(key_arn=s.kms_key_arn, region=s.aws_region)
