"""Health and readiness probes."""
from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine import __version__
from klio_engine.dependencies import get_session

router = APIRouter()


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": __version__}


@router.get("/ready")
async def ready(session: AsyncSession = Depends(get_session)) -> dict[str, str]:
    try:
        await session.execute(text("SELECT 1"))
        postgres_status = "ok"
    except Exception as e:
        postgres_status = f"error: {e}"
    return {
        "status": "ready" if postgres_status == "ok" else "degraded",
        "postgres": postgres_status,
    }
