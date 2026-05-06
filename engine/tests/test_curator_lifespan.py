"""Curator lifespan / scheduler-registration smoke tests.

Drives FastAPI's lifespan directly via `app.router.lifespan_context`
and asserts the scheduler's state based on `curator_enabled`.

We don't go through httpx's ASGITransport — at the version pinned
here (0.28.x) it does NOT dispatch ASGI lifespan messages, so the
startup/shutdown handlers never run under it. Driving the
lifespan context manager directly is what FastAPI itself does at
runtime, so this is the most faithful smoke test possible.

The Curator class itself is unit-tested in test_curator.py; this
file just proves the wiring at app startup is correct."""
from __future__ import annotations

import pytest


pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _hermetic_settings_env(monkeypatch):
    """Tests construct the real engine app, which loads Settings.
    Provide deterministic values so the suite runs under bare pytest."""
    monkeypatch.setenv(
        "KLIO_DATABASE_URL",
        "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio",
    )
    monkeypatch.setenv("KLIO_EMBEDDING_MODEL", "stub")
    monkeypatch.setenv("KLIO_EXTRACTION_MODEL", "stub")


async def test_lifespan_starts_scheduler_when_enabled(monkeypatch):
    """KLIO_CURATOR_ENABLED=true → scheduler attached to app.state
    and running. Job count > 0 only if there are users in the DB;
    we don't assert that here (covered in test_curator_pg-style
    integration tests). We assert scheduler.running."""
    monkeypatch.setenv("KLIO_CURATOR_ENABLED", "true")
    monkeypatch.setenv("KLIO_CURATOR_INTERVAL_SECS", "3600")
    from klio_engine.api.main import build_app
    app = build_app()
    async with app.router.lifespan_context(app):
        # Lifespan startup ran; scheduler should be on app.state.
        assert hasattr(app.state, "curator_scheduler")
        assert app.state.curator_scheduler.running is True


async def test_lifespan_skips_scheduler_when_disabled(monkeypatch):
    """KLIO_CURATOR_ENABLED=false → no scheduler attached."""
    monkeypatch.setenv("KLIO_CURATOR_ENABLED", "false")
    from klio_engine.api.main import build_app
    app = build_app()
    async with app.router.lifespan_context(app):
        # Either no attribute, or attribute exists but scheduler is
        # not running. Allow either implementation.
        sched = getattr(app.state, "curator_scheduler", None)
        if sched is not None:
            assert sched.running is False


async def test_lifespan_shuts_scheduler_down_cleanly(monkeypatch):
    """After the lifespan exits, scheduler.running == False."""
    monkeypatch.setenv("KLIO_CURATOR_ENABLED", "true")
    from klio_engine.api.main import build_app
    app = build_app()
    async with app.router.lifespan_context(app):
        sched = app.state.curator_scheduler
        assert sched.running is True
    # After context exit, lifespan teardown ran.
    assert sched.running is False
