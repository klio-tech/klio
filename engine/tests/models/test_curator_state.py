"""CuratorState model — column shape + defaults.

DB-backed insert / read tests live in test_curator_integration.py.
This file is pure-python and only checks the SQLAlchemy mapping."""
from __future__ import annotations

from datetime import datetime, timezone

from klio_engine.models.curator_state import CuratorState


def test_model_has_expected_columns() -> None:
    cols = {c.name for c in CuratorState.__table__.columns}
    assert cols == {
        "user_id",
        "last_run_at",
        "last_cursor_at",
        "runs_count",
        "last_error",
        "last_synthesized",
    }


def test_user_id_is_primary_key() -> None:
    pk = [c.name for c in CuratorState.__table__.primary_key]
    assert pk == ["user_id"]


def test_runs_count_default_is_zero() -> None:
    col = CuratorState.__table__.columns["runs_count"]
    # SQLAlchemy stores the Python-level default in `default.arg` for
    # scalar defaults.
    assert col.default.arg == 0


def test_last_synthesized_default_is_zero() -> None:
    col = CuratorState.__table__.columns["last_synthesized"]
    assert col.default.arg == 0


def test_last_cursor_at_has_epoch_default() -> None:
    """Default '1970-01-01' so a brand-new user picks up every
    observation they own on the first tick. Pin the actual default
    text so a future refactor can't silently swap the sentinel."""
    col = CuratorState.__table__.columns["last_cursor_at"]
    assert col.server_default is not None
    # SQLAlchemy stores the text() default behind .arg.
    # Use str() to handle TextClause's __str__ contract regardless
    # of SA version.
    assert "1970-01-01" in str(col.server_default.arg)
