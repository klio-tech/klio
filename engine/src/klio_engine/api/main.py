"""Klio engine + coordinator FastAPI app.

For v0 we co-locate the engine and coordinator routers in a single FastAPI
application. They can be split into separate processes later by importing
only the relevant routers in a new entrypoint — the routers themselves don't
hold cross-state.
"""
from fastapi import FastAPI

from klio_engine import __version__
from klio_engine.api.agents import agents_router, audit_router
from klio_engine.api.entries import entry_delete_router
from klio_engine.api.entries import recall_router
from klio_engine.api.entries import router as entries_router
from klio_engine.api.health import router as health_router
from klio_engine.api.ingest import router as ingest_router
from klio_engine.api.spaces import permissions_router
from klio_engine.api.spaces import router as spaces_router
from klio_engine.api.users import router as users_router
from klio_engine.api.users import tokens_router


def build_app() -> FastAPI:
    app = FastAPI(
        title="Klio",
        version=__version__,
        docs_url="/docs",
        redoc_url=None,
    )
    app.include_router(health_router)
    app.include_router(users_router)
    app.include_router(tokens_router)
    app.include_router(spaces_router)
    app.include_router(permissions_router)
    app.include_router(entries_router)
    app.include_router(entry_delete_router)
    app.include_router(recall_router)
    app.include_router(agents_router)
    app.include_router(audit_router)
    app.include_router(ingest_router)
    return app


app = build_app()
