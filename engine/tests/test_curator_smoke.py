"""Smoke test that APScheduler is importable.

This exists to catch a missing dependency at PR-merge time rather than
at engine startup in production. The full curator suite below uses a
hand-rolled fake scheduler so the rest of the tests don't depend on
APScheduler internals."""
from __future__ import annotations

def test_apscheduler_is_importable() -> None:
    from apscheduler.schedulers.asyncio import AsyncIOScheduler  # noqa: F401
    from apscheduler.triggers.interval import IntervalTrigger  # noqa: F401
