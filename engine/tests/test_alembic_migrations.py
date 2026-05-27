"""Per-migration shape assertions.

These tests run `alembic upgrade head` against the dev Postgres
(`KLIO_TEST_DATABASE_URL`, default `postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio`)
and then inspect the resulting `public` schema. Each test asserts the
column/index/constraint shape that a specific migration is responsible
for, so a future migration accidentally dropping or renaming a column
fails loudly.

The broader "migrations apply cleanly" smoke test lives in
`test_migrations.py`; this file is the per-column microscope.
"""
from __future__ import annotations

import os
import subprocess
import sys

import pytest
from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import create_async_engine

from tests.conftest import TEST_DB_URL


def _run_alembic_upgrade_head() -> None:
    """Apply `alembic upgrade head` against the test DB.

    Mirrors `test_migrations.py`: invoke the alembic CLI via the
    same interpreter as pytest so the subprocess sees the project's
    `klio_engine` package regardless of how the test runner was
    launched. Runs against the configured DB's `public` schema —
    the `sessions` inspection below targets `public` explicitly to
    avoid any cross-test search_path bleed.
    """
    env = os.environ.copy()
    env["KLIO_DATABASE_URL"] = TEST_DB_URL
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        capture_output=True,
        text=True,
        cwd=os.path.join(os.path.dirname(__file__), ".."),
        env=env,
    )
    if result.returncode != 0:
        # Surface alembic's own diagnostics so a failure here is
        # actionable (typical causes: postgres not running, multiple
        # heads, model/migration drift).
        print("STDOUT:", result.stdout)
        print("STDERR:", result.stderr)
    assert result.returncode == 0, "alembic upgrade head failed"


@pytest.mark.asyncio
async def test_sessions_table_has_cwd_column() -> None:
    """0007 adds nullable cwd to sessions so the bridge can persist it.

    Idempotent: alembic tracks revisions in `alembic_version`, so a
    second run is a no-op. The column-shape assertions are pure reads
    that succeed equally on a fresh upgrade and on a DB that already
    has the column.
    """
    _run_alembic_upgrade_head()

    engine = create_async_engine(TEST_DB_URL)
    try:
        async with engine.connect() as conn:
            cols = await conn.run_sync(
                lambda sync_conn: inspect(sync_conn).get_columns(
                    "sessions", schema="public"
                )
            )
    finally:
        await engine.dispose()

    names = {c["name"] for c in cols}
    assert "cwd" in names, f"sessions.cwd missing; got: {sorted(names)}"
    cwd_col = next(c for c in cols if c["name"] == "cwd")
    assert cwd_col["nullable"] is True, "cwd must be nullable (legacy sessions)"


@pytest.mark.asyncio
async def test_projects_table_exists() -> None:
    _run_alembic_upgrade_head()
    engine = create_async_engine(TEST_DB_URL)
    async with engine.connect() as conn:
        tables = await conn.run_sync(
            lambda c: inspect(c).get_table_names(schema="public")
        )
    assert "projects" in tables, f"projects table missing; got: {sorted(tables)}"


@pytest.mark.asyncio
async def test_projects_partial_unique_indexes_present() -> None:
    """git_remote uniqueness when present; repo_root_path uniqueness
    when git_remote IS NULL. Two partial unique indexes give correct
    semantics — neither overlaps, neither requires CHECK constraints."""
    _run_alembic_upgrade_head()
    engine = create_async_engine(TEST_DB_URL)
    async with engine.connect() as conn:
        idx = await conn.run_sync(
            lambda c: inspect(c).get_indexes("projects", schema="public")
        )
    by_name = {i["name"]: i for i in idx}
    assert "projects_user_remote_idx" in by_name, \
        f"projects_user_remote_idx missing; got: {sorted(by_name)}"
    assert "projects_user_path_idx" in by_name, \
        f"projects_user_path_idx missing; got: {sorted(by_name)}"
    assert by_name["projects_user_remote_idx"]["unique"] is True
    assert by_name["projects_user_path_idx"]["unique"] is True


@pytest.mark.asyncio
async def test_entries_has_project_id_fk() -> None:
    _run_alembic_upgrade_head()
    engine = create_async_engine(TEST_DB_URL)
    async with engine.connect() as conn:
        cols = await conn.run_sync(
            lambda c: inspect(c).get_columns("entries", schema="public")
        )
        fks = await conn.run_sync(
            lambda c: inspect(c).get_foreign_keys("entries", schema="public")
        )
    names = {c["name"] for c in cols}
    assert "project_id" in names, f"entries.project_id missing; got: {sorted(names)}"
    project_col = next(c for c in cols if c["name"] == "project_id")
    assert project_col["nullable"] is True, "project_id must be nullable (legacy entries)"
    assert any(
        fk["referred_table"] == "projects" and "project_id" in fk["constrained_columns"]
        for fk in fks
    ), f"FK from entries.project_id to projects missing; got fks: {fks}"
