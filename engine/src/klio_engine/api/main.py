"""Klio engine + coordinator FastAPI app.

For v0 we co-locate the engine and coordinator routers in a single FastAPI
application. They can be split into separate processes later by importing
only the relevant routers in a new entrypoint — the routers themselves don't
hold cross-state.
"""
from fastapi import FastAPI

from klio_engine import __version__
from klio_engine.api.health import router as health_router
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
    return app


app = build_app()
