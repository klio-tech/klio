"""FastAPI dependency injection."""
from collections.abc import AsyncIterator
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from klio_engine.config import Settings
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.crypto.local_kms import LocalFileKMSClient
from klio_engine.db import build_engine


class KMSBackend(Protocol):
    """Common surface implemented by both `KMSClient` (AWS) and
    `LocalFileKMSClient` (file-backed dev). Endpoints type their KMS
    dependency against this Protocol so backend swaps are transparent."""

    def generate_envelope_key(self) -> tuple[bytes, bytes]: ...
    def unwrap_envelope_key(self, wrapped_key: bytes) -> bytes: ...


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


def get_kms() -> KMSBackend:
    """Return the configured KMS backend.

    If `KLIO_DEV_KMS_PATH` is set, returns a file-backed local KMS
    suitable for `klio dev` (survives engine restarts, no AWS creds).
    Otherwise returns the AWS-backed `KMSClient`.
    """
    s = _settings()
    if s.dev_kms_path:
        return LocalFileKMSClient(s.dev_kms_path)
    return KMSClient(key_arn=s.kms_key_arn, region=s.aws_region)
