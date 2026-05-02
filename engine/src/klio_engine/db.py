"""SQLAlchemy async engine factory."""
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine


def build_engine(url: str, *, echo: bool = False) -> AsyncEngine:
    """Build a SQLAlchemy AsyncEngine pointed at the given Postgres URL.

    The URL must use the asyncpg driver (postgresql+asyncpg://).
    """
    return create_async_engine(
        url,
        echo=echo,
        pool_pre_ping=True,
        pool_size=10,
        max_overflow=20,
    )
