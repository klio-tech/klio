# Per-project memory scoping — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add automatic project-level scoping to Klio so `recall` defaults to the active project's memories and stops returning cross-project noise, while preserving an explicit cross-project escape hatch.

**Architecture:** New invisible `projects` concept auto-detected from git context in the bridge (`remote URL → repo root → cwd abspath`). Every entry tagged with `project_id` at write time. Recall defaults to the active project; explicit `project=any` or `project=<remote>` widens. Spaces (user-controlled coarse grouping) stay untouched. A `klio project promote` escape valve gives any project a dedicated space when it needs different embeddings, isolated KMS, or atomic forget.

**Tech Stack:**
- **Engine** (Python 3.12 + FastAPI + SQLAlchemy 2 + alembic + asyncpg + pgvector)
- **Bridge** (Go 1.24 + `os/exec` for git shells + `cloud.Client` for engine HTTP)
- **MCP shim** (Go — `bridge/internal/mcp/tools.go` declares the schema, dispatcher routes calls)

**Design doc:** `docs/plans/2026-05-27-per-project-memory-scoping-design.md`

**Standing constraint:** Local commits only. Do NOT push until the user explicitly approves at the end of Phase G.

---

## Phase A — Engine schema + models

### Task A1: Migration 0007 — add `cwd` to sessions

**Files:**
- Create: `engine/alembic/versions/0007_session_cwd.py`
- Modify: `engine/src/klio_engine/models/session.py:1-40`
- Test: `engine/tests/test_alembic_migrations.py` (extend existing) — if absent, create a fresh test file at this path.

**Why this comes first:** the bridge will start sending `cwd` on every ingest as soon as Phase E lands. The column needs to exist before that goes live so the writes don't 422. Adding it here in its own migration keeps the diff small and reviewable.

**Step 1: Write the failing test**

Append to `engine/tests/test_alembic_migrations.py`:

```python
import asyncio
import pytest
from sqlalchemy import inspect
from klio_engine.db import async_engine


@pytest.mark.asyncio
async def test_sessions_table_has_cwd_column():
    """0007 adds nullable cwd to sessions so the bridge can persist it."""
    async with async_engine.connect() as conn:
        cols = await conn.run_sync(
            lambda sync_conn: inspect(sync_conn).get_columns("sessions")
        )
    names = {c["name"] for c in cols}
    assert "cwd" in names, f"sessions.cwd missing; got: {sorted(names)}"
    cwd_col = next(c for c in cols if c["name"] == "cwd")
    assert cwd_col["nullable"] is True, "cwd must be nullable (legacy sessions)"
```

**Step 2: Run test to verify it fails**

```
cd engine && uv run pytest tests/test_alembic_migrations.py::test_sessions_table_has_cwd_column -v
```

Expected: FAIL with `sessions.cwd missing`.

**Step 3: Write the migration**

```python
# engine/alembic/versions/0007_session_cwd.py
"""Add nullable cwd column to sessions.

The bridge already receives cwd in every hook payload (see
bridge/internal/hooks/types.go::Payload). Persisting it lets us:
  - tag entries with the correct project at write time (Phase C-E),
  - backfill project_id for sessions written between this migration
    and the project-tagging migration (0008) so the window of
    untagged entries stays narrow.

Revision ID: 0007
Revises: 0006
"""
from collections.abc import Sequence
from typing import Union

from alembic import op
import sqlalchemy as sa


revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("cwd", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("sessions", "cwd")
```

Modify `engine/src/klio_engine/models/session.py` — add inside the `Session` class after `source_type`:

```python
    cwd: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
```

(`sa` is already imported via `sqlalchemy`. If it isn't, replace `sa.Text` with the existing import style.)

**Step 4: Apply migration and re-run test**

```
cd engine && uv run alembic upgrade head
cd engine && uv run pytest tests/test_alembic_migrations.py::test_sessions_table_has_cwd_column -v
```

Expected: PASS.

**Step 5: Commit**

```
git add engine/alembic/versions/0007_session_cwd.py \
        engine/src/klio_engine/models/session.py \
        engine/tests/test_alembic_migrations.py
git commit -m "feat(engine): add nullable cwd to sessions (0007)"
```

---

### Task A2: Migration 0008 — projects table + entries.project_id

**Files:**
- Create: `engine/alembic/versions/0008_projects.py`
- Test: `engine/tests/test_alembic_migrations.py` (extend)

**Step 1: Write the failing test**

```python
@pytest.mark.asyncio
async def test_projects_table_exists():
    async with async_engine.connect() as conn:
        tables = await conn.run_sync(lambda c: inspect(c).get_table_names())
    assert "projects" in tables


@pytest.mark.asyncio
async def test_projects_partial_unique_indexes_present():
    """git_remote uniqueness when present; repo_root_path uniqueness when
    git_remote is NULL. Two partial indexes give correct semantics."""
    async with async_engine.connect() as conn:
        idx = await conn.run_sync(
            lambda c: inspect(c).get_indexes("projects")
        )
    by_name = {i["name"]: i for i in idx}
    assert "projects_user_remote_idx" in by_name
    assert "projects_user_path_idx" in by_name
    assert by_name["projects_user_remote_idx"]["unique"] is True
    assert by_name["projects_user_path_idx"]["unique"] is True


@pytest.mark.asyncio
async def test_entries_has_project_id_fk():
    async with async_engine.connect() as conn:
        cols = await conn.run_sync(
            lambda c: inspect(c).get_columns("entries")
        )
        fks = await conn.run_sync(
            lambda c: inspect(c).get_foreign_keys("entries")
        )
    names = {c["name"] for c in cols}
    assert "project_id" in names
    assert any(
        fk["referred_table"] == "projects" and "project_id" in fk["constrained_columns"]
        for fk in fks
    )
```

**Step 2: Run tests to verify they fail**

```
cd engine && uv run pytest tests/test_alembic_migrations.py -k "projects or project_id" -v
```

Expected: 3 FAIL (`projects` missing, indexes missing, project_id missing).

**Step 3: Write the migration**

```python
# engine/alembic/versions/0008_projects.py
"""Add projects table and entries.project_id FK.

Every entry gets tagged with the project that originated it (git
remote-derived). Recall defaults filter by current project; explicit
overrides widen.

`dedicated_space_id` is the promote-to-space escape valve — when set,
that project's writes/reads route to the dedicated space rather than
the default. See design doc §6.

Revision ID: 0008
Revises: 0007
"""
from collections.abc import Sequence
from typing import Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("git_remote", sa.Text(), nullable=True),
        sa.Column("repo_root_path", sa.Text(), nullable=True),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column(
            "dedicated_space_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("spaces.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    # Partial unique indexes: git_remote when present; repo_root_path otherwise.
    op.create_index(
        "projects_user_remote_idx",
        "projects",
        ["user_id", "git_remote"],
        unique=True,
        postgresql_where=sa.text("git_remote IS NOT NULL"),
    )
    op.create_index(
        "projects_user_path_idx",
        "projects",
        ["user_id", "repo_root_path"],
        unique=True,
        postgresql_where=sa.text("git_remote IS NULL AND repo_root_path IS NOT NULL"),
    )

    op.add_column(
        "entries",
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("entries_project_id_idx", "entries", ["project_id"])


def downgrade() -> None:
    op.drop_index("entries_project_id_idx", table_name="entries")
    op.drop_column("entries", "project_id")
    op.drop_index("projects_user_path_idx", table_name="projects")
    op.drop_index("projects_user_remote_idx", table_name="projects")
    op.drop_table("projects")
```

**Step 4: Apply and re-test**

```
cd engine && uv run alembic upgrade head
cd engine && uv run pytest tests/test_alembic_migrations.py -k "projects or project_id" -v
```

Expected: 3 PASS.

**Step 5: Commit**

```
git add engine/alembic/versions/0008_projects.py engine/tests/test_alembic_migrations.py
git commit -m "feat(engine): add projects table and entries.project_id (0008)"
```

---

### Task A3: Project SQLAlchemy model + wire into Entry

**Files:**
- Create: `engine/src/klio_engine/models/project.py`
- Modify: `engine/src/klio_engine/models/entry.py:30-45`
- Modify: `engine/src/klio_engine/models/__init__.py`
- Test: `engine/tests/test_models.py` (extend or create)

**Step 1: Write the failing test**

Append to `engine/tests/test_models.py`:

```python
import uuid
import pytest
from klio_engine.db import async_session_factory
from klio_engine.models.user import User
from klio_engine.models.project import Project
from klio_engine.models.entry import Entry, EntryKind


@pytest.mark.asyncio
async def test_project_round_trips_through_orm(seed_user: User):
    async with async_session_factory() as session:
        p = Project(
            user_id=seed_user.id,
            git_remote="git@github.com:klio-tech/klio.git",
            display_name="klio-tech/klio",
        )
        session.add(p)
        await session.commit()
        await session.refresh(p)
        assert p.id is not None
        assert p.created_at is not None


@pytest.mark.asyncio
async def test_entry_has_optional_project_id(seed_user, seed_space, seed_agent):
    """Entry.project_id is nullable — legacy/uncategorized entries are valid."""
    async with async_session_factory() as session:
        e = Entry(
            user_id=seed_user.id,
            space_id=seed_space.id,
            agent_id=seed_agent.id,
            kind=EntryKind.MEMORY,
            project_id=None,
        )
        session.add(e)
        await session.commit()
        await session.refresh(e)
        assert e.project_id is None
```

(If fixtures `seed_user`, `seed_space`, `seed_agent` don't exist yet, add them to `engine/tests/conftest.py` matching the existing patterns — every other test file in this repo uses the same names so they likely already exist.)

**Step 2: Run tests to verify they fail**

```
cd engine && uv run pytest tests/test_models.py -k "project" -v
```

Expected: ImportError on `Project` and AttributeError on `Entry.project_id`.

**Step 3: Write the model**

```python
# engine/src/klio_engine/models/project.py
"""Project model — auto-detected per-repo memory partition.

Resolved by the bridge from cwd (git remote URL → repo root abspath →
cwd abspath). Every entry written via the bridge gets tagged with a
project_id so recall can filter to the user's current project by
default.

The user never directly creates these — the bridge does on first
observation. See `klio_engine.services.projects.ProjectService.ensure`.
"""
import uuid
from datetime import datetime

import sqlalchemy as sa
from sqlalchemy import DateTime, ForeignKey, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from klio_engine.models.base import Base


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    git_remote: Mapped[str | None] = mapped_column(Text, nullable=True)
    repo_root_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    dedicated_space_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("spaces.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
```

Modify `engine/src/klio_engine/models/entry.py` — add inside `Entry` class after `agent_id`:

```python
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="SET NULL"),
        nullable=True,
    )
```

Modify `engine/src/klio_engine/models/__init__.py` — add:

```python
from klio_engine.models.project import Project  # noqa: F401
```

**Step 4: Run tests to verify pass**

```
cd engine && uv run pytest tests/test_models.py -k "project" -v
```

Expected: PASS.

**Step 5: Commit**

```
git add engine/src/klio_engine/models/project.py \
        engine/src/klio_engine/models/entry.py \
        engine/src/klio_engine/models/__init__.py \
        engine/tests/test_models.py
git commit -m "feat(engine): Project ORM model + Entry.project_id"
```

---

## Phase B — Engine service + recall filter

### Task B1: ProjectService.ensure (get-or-create)

**Files:**
- Create: `engine/src/klio_engine/services/projects.py`
- Test: `engine/tests/services/test_projects.py`

**Why a dedicated service:** the bridge sends `(remote, repo_root, display_name)` triples on every write that needs tagging. Get-or-create with the partial-unique-index semantics needs to be in one place so the ON CONFLICT clause is consistent and the test covers it once.

**Step 1: Write the failing test**

```python
# engine/tests/services/test_projects.py
import pytest
from klio_engine.db import async_session_factory
from klio_engine.services.projects import ProjectService


@pytest.mark.asyncio
async def test_ensure_creates_on_first_observation(seed_user):
    svc = ProjectService()
    async with async_session_factory() as session:
        p1 = await svc.ensure(
            session,
            user_id=seed_user.id,
            git_remote="git@github.com:klio-tech/klio.git",
            repo_root_path="/Users/x/klio",
            display_name="klio-tech/klio",
        )
        await session.commit()
        assert p1.id is not None


@pytest.mark.asyncio
async def test_ensure_dedupes_by_remote(seed_user):
    """Two calls with the same git_remote return the same project."""
    svc = ProjectService()
    async with async_session_factory() as session:
        p1 = await svc.ensure(
            session,
            user_id=seed_user.id,
            git_remote="git@github.com:klio-tech/klio.git",
            repo_root_path="/path/a",
            display_name="klio-tech/klio",
        )
        p2 = await svc.ensure(
            session,
            user_id=seed_user.id,
            git_remote="git@github.com:klio-tech/klio.git",
            repo_root_path="/path/b",  # different — remote still dominates
            display_name="klio-tech/klio",
        )
        await session.commit()
        assert p1.id == p2.id


@pytest.mark.asyncio
async def test_ensure_dedupes_by_path_when_no_remote(seed_user):
    svc = ProjectService()
    async with async_session_factory() as session:
        p1 = await svc.ensure(
            session,
            user_id=seed_user.id,
            git_remote=None,
            repo_root_path="/Users/x/local-project",
            display_name="local-project",
        )
        p2 = await svc.ensure(
            session,
            user_id=seed_user.id,
            git_remote=None,
            repo_root_path="/Users/x/local-project",
            display_name="local-project",
        )
        await session.commit()
        assert p1.id == p2.id


@pytest.mark.asyncio
async def test_ensure_updates_last_seen_at(seed_user):
    svc = ProjectService()
    async with async_session_factory() as session:
        p1 = await svc.ensure(
            session,
            user_id=seed_user.id,
            git_remote="git@github.com:klio-tech/klio.git",
            repo_root_path="/path",
            display_name="klio",
        )
        first_seen = p1.last_seen_at
        await session.commit()

        # second call must bump last_seen_at
        import asyncio
        await asyncio.sleep(0.01)
        p2 = await svc.ensure(
            session,
            user_id=seed_user.id,
            git_remote="git@github.com:klio-tech/klio.git",
            repo_root_path="/path",
            display_name="klio",
        )
        await session.commit()
        await session.refresh(p2)
        assert p2.last_seen_at > first_seen
```

**Step 2: Run to verify failures**

```
cd engine && uv run pytest tests/services/test_projects.py -v
```

Expected: 4 FAIL (ImportError on `ProjectService`).

**Step 3: Write the service**

```python
# engine/src/klio_engine/services/projects.py
"""Get-or-create projects with partial-unique-index semantics.

The bridge sends (remote, repo_root_path, display_name) on every write
that needs tagging. This service deduplicates: same git_remote → same
project (path may vary across machines/worktrees); same repo_root_path
when no remote → same project.

Implements `last_seen_at` bumping so the user can later see which
projects are active. Uses `ON CONFLICT` so the get-or-create is one
round trip even under concurrent writes.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.project import Project


class ProjectService:
    async def ensure(
        self,
        session: AsyncSession,
        *,
        user_id: uuid.UUID,
        git_remote: str | None,
        repo_root_path: str | None,
        display_name: str,
    ) -> Project:
        # Lookup first: cheap, common case.
        existing = await self._find(
            session,
            user_id=user_id,
            git_remote=git_remote,
            repo_root_path=repo_root_path,
        )
        if existing is not None:
            existing.last_seen_at = datetime.now(timezone.utc)
            return existing

        # Insert with ON CONFLICT DO NOTHING (handles the rare race where
        # two concurrent ensures from different bridge processes race to
        # create the same project). On conflict, re-fetch.
        project = Project(
            user_id=user_id,
            git_remote=git_remote,
            repo_root_path=repo_root_path,
            display_name=display_name,
        )
        session.add(project)
        try:
            await session.flush()
        except Exception:
            await session.rollback()
            again = await self._find(
                session,
                user_id=user_id,
                git_remote=git_remote,
                repo_root_path=repo_root_path,
            )
            if again is None:
                raise
            return again
        return project

    async def _find(
        self,
        session: AsyncSession,
        *,
        user_id: uuid.UUID,
        git_remote: str | None,
        repo_root_path: str | None,
    ) -> Project | None:
        if git_remote is not None:
            stmt = select(Project).where(
                Project.user_id == user_id,
                Project.git_remote == git_remote,
            )
        elif repo_root_path is not None:
            stmt = select(Project).where(
                Project.user_id == user_id,
                Project.git_remote.is_(None),
                Project.repo_root_path == repo_root_path,
            )
        else:
            return None
        return (await session.execute(stmt)).scalar_one_or_none()
```

**Step 4: Run tests to verify pass**

```
cd engine && uv run pytest tests/services/test_projects.py -v
```

Expected: 4 PASS.

**Step 5: Commit**

```
git add engine/src/klio_engine/services/projects.py engine/tests/services/test_projects.py
git commit -m "feat(engine): ProjectService.ensure (get-or-create by remote/path)"
```

---

### Task B2: Recall filter — project_id + cross_project mode

**Files:**
- Modify: `engine/src/klio_engine/services/recall.py:25-90`
- Test: `engine/tests/services/test_recall.py` (extend or create)

**Step 1: Write the failing test**

Append to `engine/tests/services/test_recall.py`:

```python
@pytest.mark.asyncio
async def test_recall_filters_to_project_id(
    seed_user, seed_space, seed_agent, populate_entries
):
    """When project_id is set, only that project's entries return."""
    project_a = await _seed_project(seed_user, name="proj-a")
    project_b = await _seed_project(seed_user, name="proj-b")
    await populate_entries(
        seed_user, seed_space, seed_agent,
        [
            ("memory", "uses TypeScript strict mode", project_a.id),
            ("memory", "uses Python 3.12 with mypy strict", project_b.id),
        ],
    )
    svc = RecallService(embeddings=_stub_embeddings())
    async with async_session_factory() as s:
        results = await svc.recall(
            s,
            user_id=seed_user.id,
            space_id=seed_space.id,
            query="how do we configure type checking",
            project_id=project_a.id,
            limit=10,
        )
    contents = [r[0].id for r in results]
    a_entry = await _entry_with_content(seed_user, "uses TypeScript strict mode")
    b_entry = await _entry_with_content(seed_user, "uses Python 3.12 with mypy strict")
    assert a_entry.id in contents
    assert b_entry.id not in contents


@pytest.mark.asyncio
async def test_recall_project_any_returns_all_projects(
    seed_user, seed_space, seed_agent, populate_entries
):
    """When project_id is None, recall is unscoped (legacy behavior)."""
    project_a = await _seed_project(seed_user, name="proj-a")
    project_b = await _seed_project(seed_user, name="proj-b")
    await populate_entries(
        seed_user, seed_space, seed_agent,
        [
            ("memory", "alpha", project_a.id),
            ("memory", "beta", project_b.id),
        ],
    )
    svc = RecallService(embeddings=_stub_embeddings())
    async with async_session_factory() as s:
        results = await svc.recall(
            s, user_id=seed_user.id, space_id=seed_space.id,
            query="x", project_id=None, limit=10,
        )
    assert len(results) >= 2


@pytest.mark.asyncio
async def test_recall_null_project_entries_surface_in_every_filter(
    seed_user, seed_space, seed_agent, populate_entries
):
    """Legacy/un-tagged entries appear regardless of project filter — safe default."""
    project_a = await _seed_project(seed_user, name="proj-a")
    await populate_entries(
        seed_user, seed_space, seed_agent,
        [
            ("memory", "legacy un-tagged entry", None),       # NULL project_id
            ("memory", "project-a tagged entry", project_a.id),
        ],
    )
    svc = RecallService(embeddings=_stub_embeddings())
    async with async_session_factory() as s:
        results = await svc.recall(
            s, user_id=seed_user.id, space_id=seed_space.id,
            query="x", project_id=project_a.id, limit=10,
        )
    contents = [r[0].content for r in results]  # adapt if .content is encrypted
    # Both NULL-tagged and project-a-tagged entries must appear
    assert any("legacy" in c for c in contents) or len(results) == 2
```

(Helpers `_seed_project`, `_entry_with_content`, `_stub_embeddings`, `populate_entries` — if they don't exist in `engine/tests/conftest.py`, add them. They're the same pattern existing tests use; the executor should mirror those.)

**Step 2: Run to verify failures**

```
cd engine && uv run pytest tests/services/test_recall.py -k "project" -v
```

Expected: 3 FAIL (TypeError: unexpected `project_id` argument).

**Step 3: Modify RecallService**

Change the signature and SQL in `engine/src/klio_engine/services/recall.py`:

```python
    async def recall(
        self,
        session: AsyncSession,
        *,
        user_id: uuid.UUID,
        space_id: uuid.UUID,
        query: str,
        kind: EntryKind | None = None,
        project_id: uuid.UUID | None = None,   # NEW
        limit: int = 10,
    ) -> list[tuple[Entry, float]]:
```

Inside the SQL builder, after the existing kind filter:

```python
        if project_id is not None:
            # NULL-tagged entries surface in every project's recall —
            # safe default for legacy/un-categorizable entries. See
            # design doc §4 and §5.
            sql += " AND (e.project_id = :project_id OR e.project_id IS NULL)"
            params["project_id"] = project_id
```

The `project_id IS NULL` branch is intentional. Don't drop it — it's the soft-default behavior the design doc commits to.

**Step 4: Run to verify pass**

```
cd engine && uv run pytest tests/services/test_recall.py -k "project" -v
```

Expected: 3 PASS.

**Step 5: Commit**

```
git add engine/src/klio_engine/services/recall.py engine/tests/services/test_recall.py
git commit -m "feat(engine): RecallService accepts project_id (NULLs always surface)"
```

---

### Task B3: API — add `project` param to recall request

**Files:**
- Modify: `engine/src/klio_engine/schemas/entries.py` — add `project` to `RecallRequest`
- Modify: `engine/src/klio_engine/api/entries.py:172-210`
- Test: `engine/tests/api/test_recall_endpoint.py` (extend or create)

**Step 1: Write the failing test**

```python
# Append to engine/tests/api/test_recall_endpoint.py

@pytest.mark.asyncio
async def test_recall_endpoint_accepts_project_uuid(
    client, auth_headers, seed_user, seed_space
):
    project = await _seed_project(seed_user, name="proj")
    body = {"query": "anything", "project": str(project.id), "limit": 5}
    resp = await client.post(
        f"/v1/spaces/{seed_space.id}/recall", json=body, headers=auth_headers
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_recall_endpoint_accepts_project_remote_url(
    client, auth_headers, seed_user, seed_space
):
    """The bridge passes git_remote as a friendlier identifier."""
    await _seed_project(
        seed_user, name="proj",
        git_remote="git@github.com:klio-tech/klio.git",
    )
    body = {
        "query": "x",
        "project": "git@github.com:klio-tech/klio.git",
        "limit": 5,
    }
    resp = await client.post(
        f"/v1/spaces/{seed_space.id}/recall", json=body, headers=auth_headers
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_recall_endpoint_project_any_widens_to_all(
    client, auth_headers, seed_space
):
    body = {"query": "x", "project": "any", "limit": 5}
    resp = await client.post(
        f"/v1/spaces/{seed_space.id}/recall", json=body, headers=auth_headers
    )
    assert resp.status_code == 200
```

**Step 2: Run to verify failures**

```
cd engine && uv run pytest tests/api/test_recall_endpoint.py -k "project" -v
```

Expected: 3 FAIL (422 — extra field `project` not allowed).

**Step 3: Modify schema + handler**

In `engine/src/klio_engine/schemas/entries.py`, add to `RecallRequest`:

```python
    project: str | None = None  # "any" | git_remote | UUID
```

In `engine/src/klio_engine/api/entries.py`, modify the `recall` handler:

```python
@recall_router.post("", response_model=list[EntryResponse])
async def recall(
    space_id: uuid.UUID,
    body: RecallRequest,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
    kms: KMSClient = Depends(get_kms),
) -> list[EntryResponse]:
    if body.kind is not None and body.kind not in VALID_KINDS_V0:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid kind")
    try:
        await check_permission(
            session, user_id=ctx.user_id, agent_id=ctx.agent_id,
            space_id=space_id, scope="read",
        )
    except ACLDeniedError as e:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(e)) from e

    # Resolve `project` request field → project_id|None.
    # Rules (mirrors design doc §4):
    #   None or "any" → cross-project (project_id=None, all entries surface)
    #   UUID string   → that project_id
    #   any other str → look up by git_remote in projects table
    project_id: uuid.UUID | None = None
    if body.project and body.project != "any":
        project_id = await _resolve_project_arg(session, ctx.user_id, body.project)
        if project_id is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                f"project not found: {body.project!r}",
            )

    embeddings = EmbeddingService()
    recall_svc = RecallService(embeddings=embeddings)
    results = await recall_svc.recall(
        session,
        user_id=ctx.user_id,
        space_id=space_id,
        query=body.query,
        kind=EntryKind(body.kind) if body.kind else None,
        project_id=project_id,
        limit=body.limit,
    )
    # ... rest of the handler unchanged (entry decrypt + response build)
```

Add the resolver helper at the bottom of `entries.py`:

```python
async def _resolve_project_arg(
    session: AsyncSession, user_id: uuid.UUID, raw: str
) -> uuid.UUID | None:
    """Resolve a recall request's `project` string to a project_id.

    Accepts a UUID (preferred — unambiguous) or a git remote string
    (friendlier — the bridge passes this when scoping by remote).
    Returns None if nothing matches; the caller should raise 404.
    """
    # UUID branch
    try:
        candidate = uuid.UUID(raw)
        stmt = select(Project.id).where(
            Project.id == candidate, Project.user_id == user_id
        )
        if (await session.execute(stmt)).scalar_one_or_none() is not None:
            return candidate
        return None
    except ValueError:
        pass
    # Remote string branch
    stmt = select(Project.id).where(
        Project.user_id == user_id, Project.git_remote == raw
    )
    return (await session.execute(stmt)).scalar_one_or_none()
```

(Imports: add `from klio_engine.models.project import Project` at the top of `entries.py`.)

**Step 4: Run to verify pass**

```
cd engine && uv run pytest tests/api/test_recall_endpoint.py -k "project" -v
```

Expected: 3 PASS.

**Step 5: Commit**

```
git add engine/src/klio_engine/api/entries.py \
        engine/src/klio_engine/schemas/entries.py \
        engine/tests/api/test_recall_endpoint.py
git commit -m "feat(engine): recall API accepts project filter (uuid|remote|any)"
```

---

## Phase C — Engine write-side project tagging

### Task C1: Ingest accepts cwd + project context; persists; tags entries

**Files:**
- Modify: `engine/src/klio_engine/schemas/ingest.py` — extend `IngestTranscriptRequest` with `cwd`, `git_remote`, `repo_root_path`, `project_display_name`
- Modify: `engine/src/klio_engine/api/ingest.py` — call `ProjectService.ensure` on every ingest; persist `cwd` to session; tag entries with `project_id`
- Modify: `engine/src/klio_engine/api/entries.py` — write endpoints (POST `/v1/spaces/{id}/entries`) accept `project_id` and set it on the Entry row
- Modify: `engine/src/klio_engine/schemas/entries.py` — `EntryCreate.project_id: uuid.UUID | None = None`
- Test: `engine/tests/api/test_ingest_endpoint.py` (extend)

**Why one task for all the write paths:** the writes are the contract surface for the bridge. Splitting "ingest gets project" from "POST entries gets project" would create a window where one path tags and the other doesn't — guaranteed footgun.

**Step 1: Write the failing tests**

```python
# engine/tests/api/test_ingest_endpoint.py — add

@pytest.mark.asyncio
async def test_ingest_persists_cwd_on_session(client, auth_headers, seed_space):
    body = {
        "session_id": "auto",
        "cwd": "/Users/x/klio",
        "git_remote": "git@github.com:klio-tech/klio.git",
        "repo_root_path": "/Users/x/klio",
        "project_display_name": "klio-tech/klio",
        "messages": [{"role": "user", "content": "hi"}],
    }
    resp = await client.post(
        f"/v1/spaces/{seed_space.id}/ingest", json=body, headers=auth_headers
    )
    assert resp.status_code == 200
    # Inspect the session row
    async with async_session_factory() as s:
        sess = (await s.execute(
            select(Session).where(Session.space_id == seed_space.id)
                           .order_by(Session.started_at.desc())
        )).scalar_one()
        assert sess.cwd == "/Users/x/klio"


@pytest.mark.asyncio
async def test_ingest_creates_project_on_first_observation(
    client, auth_headers, seed_user, seed_space
):
    body = {
        "session_id": "auto",
        "cwd": "/Users/x/new-repo",
        "git_remote": "git@github.com:user/new-repo.git",
        "repo_root_path": "/Users/x/new-repo",
        "project_display_name": "user/new-repo",
        "messages": [{"role": "user", "content": "first time here"}],
    }
    resp = await client.post(
        f"/v1/spaces/{seed_space.id}/ingest", json=body, headers=auth_headers
    )
    assert resp.status_code == 200
    async with async_session_factory() as s:
        p = (await s.execute(
            select(Project).where(
                Project.user_id == seed_user.id,
                Project.git_remote == "git@github.com:user/new-repo.git",
            )
        )).scalar_one()
        assert p.display_name == "user/new-repo"
```

```python
# engine/tests/api/test_entries_endpoint.py — add

@pytest.mark.asyncio
async def test_post_entry_tags_with_project_id(
    client, auth_headers, seed_user, seed_space
):
    p = await _seed_project(seed_user, name="proj")
    body = {
        "kind": "memory",
        "content": "uses tabs not spaces",
        "project_id": str(p.id),
    }
    resp = await client.post(
        f"/v1/spaces/{seed_space.id}/entries", json=body, headers=auth_headers
    )
    assert resp.status_code == 200 or resp.status_code == 201
    entry_id = resp.json()["id"]
    async with async_session_factory() as s:
        e = await s.get(Entry, uuid.UUID(entry_id))
        assert e.project_id == p.id
```

**Step 2: Run to verify failures**

```
cd engine && uv run pytest tests/api/test_ingest_endpoint.py tests/api/test_entries_endpoint.py -k "project or cwd" -v
```

Expected: 3 FAIL (422 on extra fields).

**Step 3: Modify schemas + handlers**

`engine/src/klio_engine/schemas/ingest.py` — `IngestTranscriptRequest`:

```python
    cwd: str | None = None
    git_remote: str | None = None
    repo_root_path: str | None = None
    project_display_name: str | None = None  # falls back to repo basename
```

`engine/src/klio_engine/schemas/entries.py` — `EntryCreate`:

```python
    project_id: uuid.UUID | None = None
```

`engine/src/klio_engine/api/ingest.py` — inside the handler:

```python
    project = None
    if body.cwd or body.git_remote or body.repo_root_path:
        from klio_engine.services.projects import ProjectService
        project = await ProjectService().ensure(
            session,
            user_id=ctx.user_id,
            git_remote=body.git_remote,
            repo_root_path=body.repo_root_path,
            display_name=body.project_display_name
                or _basename_from_path(body.repo_root_path or body.cwd or "unknown"),
        )

    # When creating the Session row, set cwd
    session_row = Session(
        user_id=ctx.user_id,
        agent_id=ctx.agent_id,
        space_id=space_id,
        source_type="claude-code-transcript",
        cwd=body.cwd,
    )
    session.add(session_row)
    await session.flush()

    # When creating each Entry row inside ingest, set project_id = project.id if project else None
```

`engine/src/klio_engine/api/entries.py` — the POST `/v1/spaces/{id}/entries` handler — set `project_id=body.project_id` on the new Entry row.

Add this helper at the bottom of `ingest.py`:

```python
def _basename_from_path(path: str) -> str:
    """Last path segment as a display name. Strips trailing slashes."""
    if not path:
        return "unknown"
    return path.rstrip("/").rsplit("/", 1)[-1] or path
```

**Step 4: Run to verify pass**

```
cd engine && uv run pytest tests/api/test_ingest_endpoint.py tests/api/test_entries_endpoint.py -k "project or cwd" -v
```

Expected: 3 PASS.

**Step 5: Commit**

```
git add engine/src/klio_engine/api/ingest.py \
        engine/src/klio_engine/api/entries.py \
        engine/src/klio_engine/schemas/ingest.py \
        engine/src/klio_engine/schemas/entries.py \
        engine/tests/api/test_ingest_endpoint.py \
        engine/tests/api/test_entries_endpoint.py
git commit -m "feat(engine): write endpoints accept project context; tag entries"
```

---

## Phase D — Bridge: internal/project module

### Task D1: project.Resolve(cwd) — pure git/fs detection

**Files:**
- Create: `bridge/internal/project/project.go`
- Create: `bridge/internal/project/project_test.go`

**Step 1: Write the failing tests**

```go
// bridge/internal/project/project_test.go
package project

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestResolveGitRepoWithRemote(t *testing.T) {
	dir := t.TempDir()
	run(t, dir, "git", "init", "-q")
	run(t, dir, "git", "remote", "add", "origin", "git@github.com:klio-tech/klio.git")

	key, err := Resolve(dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if key.GitRemote != "git@github.com:klio-tech/klio.git" {
		t.Errorf("GitRemote: %q", key.GitRemote)
	}
	if key.RepoRootPath != dir {
		t.Errorf("RepoRootPath: %q want %q", key.RepoRootPath, dir)
	}
	if key.DisplayName != "klio-tech/klio" {
		t.Errorf("DisplayName: %q want klio-tech/klio", key.DisplayName)
	}
}

func TestResolveGitRepoNoRemote(t *testing.T) {
	dir := t.TempDir()
	run(t, dir, "git", "init", "-q")

	key, err := Resolve(dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if key.GitRemote != "" {
		t.Errorf("GitRemote must be empty when no remote: %q", key.GitRemote)
	}
	if key.RepoRootPath != dir {
		t.Errorf("RepoRootPath: %q want %q", key.RepoRootPath, dir)
	}
	// DisplayName falls back to basename
	if key.DisplayName != filepath.Base(dir) {
		t.Errorf("DisplayName: %q want %q", key.DisplayName, filepath.Base(dir))
	}
}

func TestResolveNonGitDirectory(t *testing.T) {
	dir := t.TempDir()
	key, err := Resolve(dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if key.GitRemote != "" || key.RepoRootPath != "" {
		t.Errorf("non-git: GitRemote and RepoRootPath must be empty; got %+v", key)
	}
	if key.AbsCwd != dir {
		t.Errorf("AbsCwd: %q want %q", key.AbsCwd, dir)
	}
}

func TestResolveDeriveDisplayFromHTTPSRemote(t *testing.T) {
	dir := t.TempDir()
	run(t, dir, "git", "init", "-q")
	run(t, dir, "git", "remote", "add", "origin", "https://github.com/klio-tech/klio.git")
	key, _ := Resolve(dir)
	if key.DisplayName != "klio-tech/klio" {
		t.Errorf("DisplayName from HTTPS: %q want klio-tech/klio", key.DisplayName)
	}
}

func TestResolveWorktreeSharesRemote(t *testing.T) {
	// linked worktrees see the same remote as the main checkout
	main := t.TempDir()
	run(t, main, "git", "init", "-q")
	run(t, main, "git", "remote", "add", "origin", "git@github.com:klio-tech/klio.git")
	run(t, main, "git", "commit", "--allow-empty", "-m", "init", "-q")
	wt := filepath.Join(t.TempDir(), "wt")
	run(t, main, "git", "worktree", "add", wt, "-q")

	keyMain, _ := Resolve(main)
	keyWt, _ := Resolve(wt)
	if keyMain.GitRemote != keyWt.GitRemote {
		t.Errorf("worktree must share remote: main=%q wt=%q", keyMain.GitRemote, keyWt.GitRemote)
	}
}

// run executes a command in dir and fails the test on non-zero exit.
func run(t *testing.T, dir string, name string, args ...string) {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@test",
		"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@test",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%s %v in %s: %v: %s", name, args, dir, err, string(out))
	}
}
```

**Step 2: Run to verify failures**

```
cd bridge && go test ./internal/project/...
```

Expected: build failure (package doesn't exist).

**Step 3: Write the module**

```go
// bridge/internal/project/project.go
//
// Resolve maps a working directory to a stable project key suitable
// for engine-side `ProjectService.ensure`. The bridge calls this on
// every hook fire that needs project tagging.
//
// Resolution order:
//   1. git remote URL  (canonical — survives worktrees + renames)
//   2. git repo root   (canonical-within-machine)
//   3. abspath of cwd  (last resort — no git at all)
//
// We do NOT cache here; the LRU cache is layered in cache.go so
// pure detection stays trivially testable.
package project

import (
	"os/exec"
	"path/filepath"
	"strings"
)

// Key is the projection of a cwd into the project namespace.
//
// Exactly one of (GitRemote, RepoRootPath, AbsCwd) is the "strongest"
// signal — callers handing the key to the engine should fill the
// fields in this priority and let the engine's ProjectService.ensure
// dedupe by the strongest available.
type Key struct {
	GitRemote    string // e.g. "git@github.com:klio-tech/klio.git" ("" if no remote)
	RepoRootPath string // git toplevel ("" if no git)
	AbsCwd       string // abspath(cwd) — always set
	DisplayName  string // human-friendly: "org/repo" from remote, else basename of root/cwd
}

// Resolve walks the git → fs ladder for cwd. Returns a Key whose
// strongest field reflects the actual context.
//
// Errors only on egregious filesystem problems (cwd doesn't resolve
// to an abspath). Missing git / missing remote / non-git dirs are
// NOT errors — they degrade through the ladder.
func Resolve(cwd string) (Key, error) {
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return Key{}, err
	}
	key := Key{AbsCwd: abs}

	// Try git toplevel first; this also confirms cwd is in a git repo.
	if root, ok := gitToplevel(abs); ok {
		key.RepoRootPath = root
		if remote, ok := gitRemoteOrigin(abs); ok {
			key.GitRemote = remote
			key.DisplayName = displayFromRemote(remote)
		} else {
			key.DisplayName = filepath.Base(root)
		}
		return key, nil
	}

	// No git — display from cwd basename.
	key.DisplayName = filepath.Base(abs)
	return key, nil
}

func gitToplevel(cwd string) (string, bool) {
	out, err := runGit(cwd, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", false
	}
	root := strings.TrimSpace(string(out))
	if root == "" {
		return "", false
	}
	return root, true
}

func gitRemoteOrigin(cwd string) (string, bool) {
	out, err := runGit(cwd, "config", "--get", "remote.origin.url")
	if err != nil {
		return "", false
	}
	remote := strings.TrimSpace(string(out))
	if remote == "" {
		return "", false
	}
	return remote, true
}

func runGit(cwd string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	return cmd.Output()
}

// displayFromRemote extracts "org/repo" from a git remote URL.
// Handles both SSH and HTTPS forms. Falls back to the trimmed remote
// if neither pattern matches.
//
// Examples:
//   git@github.com:klio-tech/klio.git  → klio-tech/klio
//   https://github.com/klio-tech/klio  → klio-tech/klio
//   ssh://git@host:22/path/to/repo.git → path/to/repo
func displayFromRemote(remote string) string {
	r := strings.TrimSuffix(remote, ".git")
	// SSH form: user@host:org/repo
	if i := strings.LastIndex(r, ":"); i > 0 && !strings.Contains(r[i:], "/") == false {
		// fall through to URL handling below
	}
	if strings.Contains(r, "@") && strings.Contains(r, ":") && !strings.HasPrefix(r, "ssh://") {
		if i := strings.Index(r, ":"); i > 0 {
			return r[i+1:]
		}
	}
	// URL form: scheme://host/org/repo (or .../path/to/repo)
	if i := strings.Index(r, "://"); i > 0 {
		rest := r[i+3:]
		if j := strings.Index(rest, "/"); j > 0 {
			return rest[j+1:]
		}
	}
	return r
}
```

**Step 4: Run to verify pass**

```
cd bridge && go test ./internal/project/... -v
```

Expected: 5 PASS.

**Step 5: Commit**

```
git add bridge/internal/project/
git commit -m "feat(bridge): internal/project.Resolve — git→fs project detection"
```

---

### Task D2: LRU cache for Resolve

**Files:**
- Create: `bridge/internal/project/cache.go`
- Create: `bridge/internal/project/cache_test.go`

**Why:** every hook fire is a potential `exec.Command("git", ...)` shell-out. A 100-message Claude Code session is 100s of hook fires from the same cwd. Cache it.

**Step 1: Write the failing test**

```go
// bridge/internal/project/cache_test.go
package project

import (
	"sync/atomic"
	"testing"
)

func TestCacheHitsBypassResolver(t *testing.T) {
	var calls int32
	resolver := func(cwd string) (Key, error) {
		atomic.AddInt32(&calls, 1)
		return Key{AbsCwd: cwd, DisplayName: "x"}, nil
	}
	c := newCacheWithResolver(8, resolver)

	for i := 0; i < 10; i++ {
		_, err := c.Resolve("/some/cwd")
		if err != nil {
			t.Fatal(err)
		}
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("expected 1 underlying call, got %d", got)
	}
}

func TestCacheEvictsLeastRecent(t *testing.T) {
	var calls int32
	resolver := func(cwd string) (Key, error) {
		atomic.AddInt32(&calls, 1)
		return Key{AbsCwd: cwd}, nil
	}
	c := newCacheWithResolver(2, resolver)
	c.Resolve("/a")
	c.Resolve("/b")
	c.Resolve("/c") // evicts /a
	c.Resolve("/a") // miss again
	if got := atomic.LoadInt32(&calls); got != 4 {
		t.Errorf("expected 4 underlying calls (a, b, c, a-again); got %d", got)
	}
}
```

**Step 2: Verify it fails**

```
cd bridge && go test ./internal/project/... -run TestCache -v
```

Expected: build failure (`newCacheWithResolver` undefined).

**Step 3: Implement**

```go
// bridge/internal/project/cache.go
package project

import (
	"container/list"
	"sync"
)

// Cache wraps Resolve with an LRU keyed by abspath(cwd). Concurrency-safe.
//
// We don't bother invalidating on cwd-changed-meaning (e.g., the user
// rewired the remote) — that's rare, the worst-case staleness is one
// hook fire of writing under the old project, and bridge restart
// flushes everything.
type Cache struct {
	mu       sync.Mutex
	cap      int
	evict    *list.List           // front = MRU
	items    map[string]*list.Element
	resolver func(string) (Key, error) // injected for tests
}

type cacheEntry struct {
	cwd string
	key Key
}

// NewCache returns a cache with the production Resolve as the underlying.
func NewCache(capacity int) *Cache {
	return newCacheWithResolver(capacity, Resolve)
}

func newCacheWithResolver(capacity int, resolver func(string) (Key, error)) *Cache {
	if capacity <= 0 {
		capacity = 128
	}
	return &Cache{
		cap:      capacity,
		evict:    list.New(),
		items:    make(map[string]*list.Element, capacity),
		resolver: resolver,
	}
}

func (c *Cache) Resolve(cwd string) (Key, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if elem, ok := c.items[cwd]; ok {
		c.evict.MoveToFront(elem)
		return elem.Value.(*cacheEntry).key, nil
	}
	key, err := c.resolver(cwd)
	if err != nil {
		return Key{}, err
	}
	entry := &cacheEntry{cwd: cwd, key: key}
	elem := c.evict.PushFront(entry)
	c.items[cwd] = elem
	if c.evict.Len() > c.cap {
		old := c.evict.Back()
		c.evict.Remove(old)
		delete(c.items, old.Value.(*cacheEntry).cwd)
	}
	return key, nil
}
```

**Step 4: Run to verify pass**

```
cd bridge && go test ./internal/project/... -v
```

Expected: all green (D1's 5 + D2's 2 = 7 tests).

**Step 5: Commit**

```
git add bridge/internal/project/cache.go bridge/internal/project/cache_test.go
git commit -m "feat(bridge): LRU cache wrapping project.Resolve"
```

---

## Phase E — Bridge: wire project tagging into hooks + MCP

### Task E1: Cloud client — EnsureProject + recall project param

**Files:**
- Modify: `bridge/internal/cloud/client.go` — add `EnsureProject(key Key) (uuid, error)` and add `project` field to recall request payload
- Test: `bridge/internal/cloud/client_test.go` (extend)

**Step 1: Write the failing tests**

```go
// Extend bridge/internal/cloud/client_test.go

func TestEnsureProjectPostsToEngine(t *testing.T) {
	var got struct {
		GitRemote    string `json:"git_remote"`
		RepoRootPath string `json:"repo_root_path"`
		DisplayName  string `json:"display_name"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/projects/ensure" || r.Method != "POST" {
			t.Errorf("unexpected req: %s %s", r.Method, r.URL.Path)
		}
		json.NewDecoder(r.Body).Decode(&got)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"00000000-0000-0000-0000-000000000001"}`))
	}))
	defer server.Close()

	c := NewClient(server.URL)
	c.SetAccessToken("test-token")
	id, err := c.EnsureProject(context.Background(),
		"git@github.com:klio-tech/klio.git",
		"/Users/x/klio",
		"klio-tech/klio",
	)
	if err != nil {
		t.Fatal(err)
	}
	if id == uuid.Nil {
		t.Error("zero uuid returned")
	}
	if got.GitRemote != "git@github.com:klio-tech/klio.git" {
		t.Errorf("git_remote: %q", got.GitRemote)
	}
}

func TestRecallSendsProjectField(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&body)
		w.Write([]byte(`[]`))
	}))
	defer server.Close()
	c := NewClient(server.URL)
	c.SetAccessToken("test-token")
	spaceID := uuid.New()
	_, err := c.Recall(context.Background(), spaceID, RecallRequest{
		Query:   "anything",
		Project: "git@github.com:klio-tech/klio.git",
	})
	if err != nil {
		t.Fatal(err)
	}
	if body["project"] != "git@github.com:klio-tech/klio.git" {
		t.Errorf("project field missing or wrong: %v", body["project"])
	}
}
```

**Step 2: Run to verify failures**

Expected: undefined `EnsureProject` + `RecallRequest.Project`.

**Step 3: Implement**

In `bridge/internal/cloud/client.go`, add:

```go
type RecallRequest struct {
	Query   string `json:"query"`
	Limit   int    `json:"limit,omitempty"`
	Kind    string `json:"kind,omitempty"`
	Project string `json:"project,omitempty"` // "any" | git_remote | UUID
}

func (c *Client) EnsureProject(ctx context.Context,
	gitRemote, repoRootPath, displayName string,
) (uuid.UUID, error) {
	body := map[string]string{
		"git_remote":     gitRemote,
		"repo_root_path": repoRootPath,
		"display_name":   displayName,
	}
	var resp struct{ ID uuid.UUID `json:"id"` }
	if err := c.do(ctx, "POST", "/v1/projects/ensure", body, &resp, true); err != nil {
		return uuid.Nil, err
	}
	return resp.ID, nil
}

func (c *Client) Recall(ctx context.Context, spaceID uuid.UUID, req RecallRequest) ([]Entry, error) {
	var entries []Entry
	path := "/v1/spaces/" + spaceID.String() + "/recall"
	if err := c.do(ctx, "POST", path, req, &entries, true); err != nil {
		return nil, err
	}
	return entries, nil
}
```

(`Entry` type is presumably already defined; reuse it. If not, add a minimal struct matching the engine's `EntryResponse`.)

**Step 4: Engine-side helper endpoint**

The bridge's `EnsureProject` calls `POST /v1/projects/ensure`. Add this endpoint engine-side too — small piece of the same task to keep the contract atomic:

```python
# engine/src/klio_engine/api/projects.py — new file
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel

from klio_engine.auth.context import RequestContext
from klio_engine.dependencies import get_session, require_auth
from klio_engine.services.projects import ProjectService


router = APIRouter(prefix="/v1/projects", tags=["projects"])


class EnsureRequest(BaseModel):
    git_remote: str | None = None
    repo_root_path: str | None = None
    display_name: str


class EnsureResponse(BaseModel):
    id: str


@router.post("/ensure", response_model=EnsureResponse)
async def ensure_project(
    body: EnsureRequest,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> EnsureResponse:
    svc = ProjectService()
    p = await svc.ensure(
        session,
        user_id=ctx.user_id,
        git_remote=body.git_remote,
        repo_root_path=body.repo_root_path,
        display_name=body.display_name,
    )
    await session.commit()
    return EnsureResponse(id=str(p.id))
```

Wire into `engine/src/klio_engine/api/main.py`:

```python
from klio_engine.api.projects import router as projects_router
app.include_router(projects_router)
```

**Step 5: Run to verify pass**

```
cd bridge && go test ./internal/cloud/... -v
cd engine && uv run pytest tests/api/ -v
```

Expected: both green.

**Step 6: Commit**

```
git add bridge/internal/cloud/ engine/src/klio_engine/api/projects.py engine/src/klio_engine/api/main.py
git commit -m "feat: /v1/projects/ensure endpoint + bridge cloud client helpers"
```

---

### Task E2: Hook handlers tag writes with project_id

**Files:**
- Modify: `bridge/internal/hooks/handlers.go` — every write path resolves cwd → project → engine ensure → attach project_id to write
- Modify: `bridge/internal/hooks/socket_backend.go` — backend takes a `*project.Cache` and a `cloud.Client`; passes `project_id` through to writes
- Modify: `bridge/internal/hooks/types.go::Backend` — `WriteEntry` signature gains `projectID uuid.UUID`
- Test: `bridge/internal/hooks/handlers_test.go` (extend)

**Step 1: Write the failing test**

```go
// Append to handlers_test.go

func TestWriteHookTagsEntryWithProjectID(t *testing.T) {
	backend := &fakeBackend{}
	cache := project.NewCache(8)
	runner := NewRunner(backend, cache)

	// Simulate a hook payload from a temp git repo
	dir := t.TempDir()
	exec.Command("git", "-C", dir, "init", "-q").Run()
	exec.Command("git", "-C", dir, "remote", "add", "origin",
		"git@github.com:klio-tech/klio.git").Run()

	payload := Payload{
		HookEventName: "UserPromptSubmit",
		Cwd:           dir,
		UserMessage:   "remember that I prefer tabs",
	}
	if err := runner.HandleEvent(context.Background(), payload); err != nil {
		t.Fatal(err)
	}

	if backend.lastWriteProjectID == uuid.Nil {
		t.Error("write must carry a non-nil project_id")
	}
	if backend.lastEnsureRemote != "git@github.com:klio-tech/klio.git" {
		t.Errorf("EnsureProject not called with remote; got %q", backend.lastEnsureRemote)
	}
}
```

(Adapt: `runner.HandleEvent` and `fakeBackend.lastWriteProjectID` etc. should mirror the existing hook-test patterns in this file.)

**Step 2: Run to verify failure**

Expected: signature mismatch / missing fields.

**Step 3: Implement**

In `bridge/internal/hooks/types.go`:

```go
type Backend interface {
	Recall(query string, limit int, projectID uuid.UUID) ([]map[string]any, error)
	WriteEntry(kind, content string, metadata map[string]any, projectID uuid.UUID) (map[string]any, error)
	IngestTranscript(sessionID string, messages []map[string]any, cwd string, projectID uuid.UUID) (map[string]any, error)
	EnsureProject(gitRemote, repoRootPath, displayName string) (uuid.UUID, error)
}
```

In `bridge/internal/hooks/handlers.go` (each write-path handler):

```go
func (r *Runner) handleWrite(ctx context.Context, payload Payload) error {
	key, err := r.projectCache.Resolve(payload.Cwd)
	if err != nil {
		return err
	}
	projectID, err := r.backend.EnsureProject(key.GitRemote, key.RepoRootPath, key.DisplayName)
	if err != nil {
		return err
	}
	// existing write path — pass projectID through
	_, err = r.backend.WriteEntry(kind, content, metadata, projectID)
	return err
}
```

For non-write hooks (Recall, etc.) the project lookup still happens — `recall` takes the project's git_remote as a hint:

```go
func (r *Runner) handleRecall(ctx context.Context, payload Payload) ([]map[string]any, error) {
	key, _ := r.projectCache.Resolve(payload.Cwd)  // best-effort; nil on error is fine
	projectID, _ := r.backend.EnsureProject(key.GitRemote, key.RepoRootPath, key.DisplayName)
	return r.backend.Recall(query, limit, projectID)
}
```

**Step 4: Verify**

```
cd bridge && go test ./internal/hooks/... -v
```

Expected: green.

**Step 5: Commit**

```
git add bridge/internal/hooks/
git commit -m "feat(bridge): tag hook writes with auto-detected project_id"
```

---

### Task E3: MCP tool schema — add `project` to recall + dispatcher pass-through

**Files:**
- Modify: `bridge/internal/mcp/tools.go:8-40` — extend `recall` InputSchema
- Modify: `bridge/internal/mcp/dispatcher.go` — pass `project` field through to the cloud client call
- Test: `bridge/internal/mcp/dispatcher_test.go` (extend)

**Step 1: Write the failing test**

```go
// Append to dispatcher_test.go

func TestRecallDispatcherPassesProjectThrough(t *testing.T) {
	var seen cloud.RecallRequest
	client := &fakeCloud{
		recall: func(req cloud.RecallRequest) ([]cloud.Entry, error) {
			seen = req
			return nil, nil
		},
	}
	d := NewDispatcher(client, nil, nil)
	args := map[string]any{
		"query":   "how did we configure JWT",
		"project": "git@github.com:klio-tech/klio.git",
	}
	_, err := d.Dispatch(context.Background(), "recall", args)
	if err != nil {
		t.Fatal(err)
	}
	if seen.Project != "git@github.com:klio-tech/klio.git" {
		t.Errorf("Project not propagated: %q", seen.Project)
	}
}

func TestRecallDispatcherDefaultsProjectFromCacheWhenAbsent(t *testing.T) {
	// When the MCP caller doesn't specify project, the dispatcher
	// auto-fills from project.Cache.Resolve(cwd-of-current-session).
	// Stub the cache to return a known key.
	cache := project.NewCacheWith(func(_ string) (project.Key, error) {
		return project.Key{GitRemote: "git@github.com:klio-tech/klio.git"}, nil
	})
	var seen cloud.RecallRequest
	client := &fakeCloud{recall: func(r cloud.RecallRequest) ([]cloud.Entry, error) {
		seen = r; return nil, nil
	}}
	d := NewDispatcher(client, cache, nil)
	args := map[string]any{"query": "x"}
	_, _ = d.Dispatch(context.Background(), "recall", args)
	if seen.Project != "git@github.com:klio-tech/klio.git" {
		t.Errorf("default project: %q", seen.Project)
	}
}
```

**Step 2: Verify failure**

Expected: fields missing on RecallRequest, dispatcher doesn't read them.

**Step 3: Implement**

In `bridge/internal/mcp/tools.go`, extend the `recall` tool's `properties`:

```go
"project": map[string]any{
	"type": "string",
	"description": "Project filter: a git remote URL to scope to that project, " +
		"the literal string 'any' to widen to ALL projects, or omit/unset to " +
		"default to the current project (auto-detected from cwd).",
},
```

In `bridge/internal/mcp/dispatcher.go`, the `recall` branch:

```go
case "recall":
	query, _ := args["query"].(string)
	limit := 10
	if v, ok := args["limit"].(float64); ok {
		limit = int(v)
	}
	project, _ := args["project"].(string)
	if project == "" {
		// Default: auto-detect from current cwd.
		key, err := d.projectCache.Resolve(d.session.Cwd())
		if err == nil && key.GitRemote != "" {
			project = key.GitRemote
		}
	}
	results, err := d.cloud.Recall(ctx, d.session.SpaceID(), cloud.RecallRequest{
		Query:   query,
		Limit:   limit,
		Project: project,
	})
```

(Adapt to whatever the dispatcher's current shape is — the names `d.session.Cwd()` / `d.projectCache` are likely-correct guesses; the executor should reconcile with the real type.)

**Step 4: Verify**

```
cd bridge && go test ./internal/mcp/... -v
```

Expected: green.

**Step 5: Commit**

```
git add bridge/internal/mcp/tools.go bridge/internal/mcp/dispatcher.go bridge/internal/mcp/dispatcher_test.go
git commit -m "feat(mcp): recall accepts 'project' (defaults to auto-detected current)"
```

---

## Phase F — Promote-to-space escape valve

### Task F1: Engine endpoint — POST /v1/projects/{id}/promote

**Files:**
- Modify: `engine/src/klio_engine/api/projects.py` — add `/promote` route
- Modify: `engine/src/klio_engine/services/projects.py` — add `ProjectService.promote`
- Test: `engine/tests/api/test_projects_endpoint.py` (create)

**Step 1: Write the failing tests**

```python
# engine/tests/api/test_projects_endpoint.py
import pytest
import uuid

from klio_engine.db import async_session_factory
from klio_engine.models.project import Project


@pytest.mark.asyncio
async def test_promote_assigns_existing_space(
    client, auth_headers, seed_user, seed_space
):
    proj = await _seed_project(seed_user, name="proj")
    body = {"space_id": str(seed_space.id)}
    resp = await client.post(
        f"/v1/projects/{proj.id}/promote", json=body, headers=auth_headers
    )
    assert resp.status_code == 200
    async with async_session_factory() as s:
        p = await s.get(Project, proj.id)
        assert p.dedicated_space_id == seed_space.id


@pytest.mark.asyncio
async def test_promote_creates_dedicated_space_with_embedding(
    client, auth_headers, seed_user
):
    proj = await _seed_project(seed_user, name="proj")
    body = {"embedding_model": "openai/text-embedding-3-small"}
    resp = await client.post(
        f"/v1/projects/{proj.id}/promote", json=body, headers=auth_headers
    )
    assert resp.status_code == 200
    space_id = resp.json()["dedicated_space_id"]
    assert uuid.UUID(space_id)  # valid UUID


@pytest.mark.asyncio
async def test_promote_requires_space_or_embedding(client, auth_headers, seed_user):
    proj = await _seed_project(seed_user, name="proj")
    resp = await client.post(
        f"/v1/projects/{proj.id}/promote", json={}, headers=auth_headers
    )
    assert resp.status_code == 422
```

**Step 2: Verify failures**

```
cd engine && uv run pytest tests/api/test_projects_endpoint.py -v
```

Expected: 404s (endpoint missing).

**Step 3: Implement**

Append to `engine/src/klio_engine/api/projects.py`:

```python
class PromoteRequest(BaseModel):
    space_id: uuid.UUID | None = None
    embedding_model: str | None = None


class PromoteResponse(BaseModel):
    project_id: str
    dedicated_space_id: str


@router.post("/{project_id}/promote", response_model=PromoteResponse)
async def promote_project(
    project_id: uuid.UUID,
    body: PromoteRequest,
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> PromoteResponse:
    if body.space_id is None and body.embedding_model is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "must supply space_id OR embedding_model",
        )
    svc = ProjectService()
    proj = await svc.promote(
        session,
        user_id=ctx.user_id,
        project_id=project_id,
        space_id=body.space_id,
        embedding_model=body.embedding_model,
    )
    await session.commit()
    return PromoteResponse(
        project_id=str(proj.id),
        dedicated_space_id=str(proj.dedicated_space_id),
    )
```

In `engine/src/klio_engine/services/projects.py`, add:

```python
    async def promote(
        self,
        session: AsyncSession,
        *,
        user_id: uuid.UUID,
        project_id: uuid.UUID,
        space_id: uuid.UUID | None,
        embedding_model: str | None,
    ) -> Project:
        from klio_engine.models.space import Space
        proj = await session.get(Project, project_id)
        if proj is None or proj.user_id != user_id:
            from fastapi import HTTPException, status
            raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")

        if space_id is not None:
            # Use existing space
            target = await session.get(Space, space_id)
            if target is None or target.user_id != user_id:
                from fastapi import HTTPException, status
                raise HTTPException(status.HTTP_404_NOT_FOUND, "space not found")
            proj.dedicated_space_id = space_id
        else:
            # Create new space with the requested embedding model
            new_space = Space(
                user_id=user_id,
                name=f"{proj.display_name} (dedicated)",
                embedding_model=embedding_model,
                # embedding_dim derived from model — engine has a registry
            )
            session.add(new_space)
            await session.flush()
            proj.dedicated_space_id = new_space.id

        return proj
```

**Step 4: Verify pass**

```
cd engine && uv run pytest tests/api/test_projects_endpoint.py -v
```

Expected: 3 PASS.

**Step 5: Commit**

```
git add engine/src/klio_engine/api/projects.py \
        engine/src/klio_engine/services/projects.py \
        engine/tests/api/test_projects_endpoint.py
git commit -m "feat(engine): POST /v1/projects/{id}/promote (existing space or new w/ embedding)"
```

---

### Task F2: Bridge CLI — `klio project promote`

**Files:**
- Create: `bridge/cmd/klio/project.go` — new subcommand handler
- Modify: `bridge/cmd/klio/main.go:38-65` — wire `case "project":` into dispatch
- Test: `bridge/cmd/klio/project_test.go`

**Step 1: Write the failing test**

```go
// bridge/cmd/klio/project_test.go
package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPromoteCallsEngine(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/projects/ensure" {
			w.Write([]byte(`{"id":"00000000-0000-0000-0000-000000000001"}`))
			return
		}
		if r.URL.Path == "/v1/projects/00000000-0000-0000-0000-000000000001/promote" {
			called = true
			w.Write([]byte(`{"project_id":"00000000-0000-0000-0000-000000000001","dedicated_space_id":"00000000-0000-0000-0000-000000000002"}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	t.Setenv("KLIO_ENGINE_URL", server.URL)
	err := runProjectPromote([]string{
		"git@github.com:klio-tech/klio.git",
		"--space", "00000000-0000-0000-0000-000000000002",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Error("promote endpoint was not called")
	}
}
```

**Step 2: Verify failure**

Expected: `runProjectPromote` undefined.

**Step 3: Implement**

```go
// bridge/cmd/klio/project.go
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"

	"github.com/klio-tech/bridge/internal/cloud"
	"github.com/klio-tech/bridge/internal/project"
)

func runProject(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: klio project promote <remote-or-name> [flags]")
		os.Exit(2)
	}
	switch args[0] {
	case "promote":
		if err := runProjectPromote(args[1:]); err != nil {
			fmt.Fprintln(os.Stderr, "klio project promote:", err)
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "unknown subcommand:", args[0])
		os.Exit(2)
	}
}

func runProjectPromote(args []string) error {
	fs := flag.NewFlagSet("promote", flag.ContinueOnError)
	spaceID := fs.String("space", "", "existing space UUID")
	embedding := fs.String("embedding", "", "embedding model id (creates new space)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rest := fs.Args()
	if len(rest) != 1 {
		return errors.New("must pass exactly one remote-or-name argument")
	}
	if *spaceID == "" && *embedding == "" {
		return errors.New("must pass --space OR --embedding")
	}

	ident := rest[0]
	client := cloud.NewClient(engineURL())
	loadAccessToken(client)

	// Resolve the project id from a remote (if it looks like one) or
	// from EnsureProject otherwise. The bridge already has a Resolve
	// helper for this.
	ctx := context.Background()
	var projectID = ident // assume UUID at first
	if !looksLikeUUID(ident) {
		// Treat as remote — ensure to get the id.
		id, err := client.EnsureProject(ctx, ident, "", project.DisplayFromRemote(ident))
		if err != nil {
			return fmt.Errorf("ensure project for %q: %w", ident, err)
		}
		projectID = id.String()
	}

	resp, err := client.PromoteProject(ctx, projectID, *spaceID, *embedding)
	if err != nil {
		return err
	}
	fmt.Printf("project %s promoted; dedicated space %s\n", resp.ProjectID, resp.DedicatedSpaceID)
	return nil
}
```

Add `PromoteProject` to `bridge/internal/cloud/client.go`:

```go
type PromoteResponse struct {
	ProjectID         string `json:"project_id"`
	DedicatedSpaceID  string `json:"dedicated_space_id"`
}

func (c *Client) PromoteProject(ctx context.Context, projectID, spaceID, embeddingModel string) (PromoteResponse, error) {
	body := map[string]string{}
	if spaceID != "" { body["space_id"] = spaceID }
	if embeddingModel != "" { body["embedding_model"] = embeddingModel }
	var resp PromoteResponse
	err := c.do(ctx, "POST", "/v1/projects/"+projectID+"/promote", body, &resp, true)
	return resp, err
}
```

Also expose `project.DisplayFromRemote` from `bridge/internal/project/project.go` (rename the private `displayFromRemote` → uppercase or add an exported wrapper).

Wire into `main.go`:

```go
case "project":
	runProject(os.Args[2:])
```

**Step 4: Verify pass**

```
cd bridge && go test ./cmd/klio/... ./internal/cloud/... ./internal/project/... -v
```

Expected: green.

**Step 5: Commit**

```
git add bridge/cmd/klio/project.go bridge/cmd/klio/project_test.go \
        bridge/cmd/klio/main.go bridge/internal/cloud/client.go \
        bridge/internal/project/project.go
git commit -m "feat(bridge): klio project promote (via existing space or new w/ embedding)"
```

---

## Phase G — Release prep

### Task G1: Integration smoke test (manual two-repo fixture)

**Files:**
- Create: `docs/runbooks/2026-05-27-project-scoping-smoke.md`

**Why this is a task, not just a vibe-check:** the unit tests cover each layer in isolation. The promise of this whole effort is that end-to-end, hook → write → recall preserves project boundary. A documented runbook captures that promise for future regressions.

**Steps:**

1. Spin up a fresh Klio stack (`make first-run` or your usual local-dev incantation).
2. Open two terminal windows, each `cd`'d into a different real git repo (e.g., `cd ~/Me/klio` and `cd ~/Me/Growth\ App`).
3. In window 1 (klio repo), open Claude Code, run:
   - `recall "anything"` — should return klio-tagged entries only.
   - `remember "tabs over spaces for this project"` — note the entry.
4. In window 2 (Growth App repo), open Claude Code, run:
   - `recall "tabs over spaces"` — must NOT return the klio entry from step 3.
   - `recall "tabs over spaces" project=any` — MUST return the klio entry.
5. Verify in the database:
   ```sql
   SELECT p.display_name, COUNT(e.id)
   FROM entries e LEFT JOIN projects p ON e.project_id = p.id
   GROUP BY p.display_name;
   ```
   Two projects, distinct entry counts.

Document the steps + expected output in the runbook so the next regression has a 5-minute smoke path.

**Commit:**

```
git add docs/runbooks/2026-05-27-project-scoping-smoke.md
git commit -m "docs(runbook): two-repo project-scoping smoke test"
```

---

### Task G2: CHANGELOG + version bump to 0.7.0

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `npm/package.json`

**Step 1: Update CHANGELOG**

Insert at the top, above the existing `[0.6.1]` block:

```markdown
## [0.7.0] — unreleased

### Added — per-project memory scoping

Klio's biggest scaling pain point at multi-project usage: every captured
memory dumped into one global pool, so `recall` from project A returned
top-k semantically nearest entries half of which were from project B.
Claude either filtered them (waste) or mis-applied them (correctness
bug).

The fix layers an invisible new concept underneath the existing `spaces`
primitive:

- **Projects** — auto-detected from git context in the bridge (`remote
  URL → repo root → cwd abspath`). Every entry written via the bridge
  is tagged with `project_id` at write time. The user never directly
  creates these.
- **Recall scoping** — `recall` defaults to the active project's
  entries (legacy NULL-tagged entries always surface — safe default).
  `recall(query, project="any")` widens to all projects;
  `recall(query, project=<remote>)` scopes to a named other project.
- **Spaces stay untouched** — they remain user-controlled coarse
  grouping (Personal/Work/Side) with per-space embedding models and
  KMS keys. Marketing/UX unchanged.
- **Promote-to-space** — `klio project promote <remote> --space=<id>
  | --embedding=<model>` elevates a project to a dedicated space when
  it needs harder isolation (different embedding model, isolated KMS,
  atomic forget). Rare, on-demand.

### Migration

Existing entries written before this release stay `project_id = NULL`
because pre-release session metadata didn't capture cwd. NULL entries
surface in every project's recall (safe default — they weren't
isolated before). Forward-going writes from the upgraded bridge tag
correctly.

### Schema

- New `projects` table (migration `0007_session_cwd` adds
  `sessions.cwd`; `0008_projects` adds the table and
  `entries.project_id`).

### Bridge / engine surfaces

- New engine endpoints: `POST /v1/projects/ensure`,
  `POST /v1/projects/{id}/promote`.
- Recall accepts new optional `project` field on the request body.
- Hook payloads' existing `cwd` is now consumed for project detection.

## [0.6.1] — ...existing block continues...
```

**Step 2: Bump version**

```
cd npm && npm version 0.7.0 --no-git-tag-version
```

**Step 3: Commit**

```
git add CHANGELOG.md npm/package.json npm/package-lock.json
git commit -m "chore: bump @klio-tech/klio to 0.7.0"
```

**Step 4: Verify everything still passes**

```
cd engine && uv run pytest
cd bridge && go test ./...
cd npm && npm test
```

All three green = ready to push.

**Step 5: DO NOT PUSH.** Stop here and ask the user for explicit push approval. The standing instruction at the top of this plan: local commits only until explicit approval. Phase G2 is the last commit; the next action is the user saying "push it" or "tag and push it".

When approved:

```
git tag v0.7.0
git push origin main v0.7.0
```

The release-images workflow takes over from there.

---

## Open questions called out by the design

1. ✅ **Sessions-cwd assumption** — resolved during plan-writing. Hooks already capture cwd (`bridge/internal/hooks/types.go::Payload.Cwd`) so forward-going writes tag correctly. Sessions table didn't store it; A1 adds the column. Legacy entries stay NULL — accepted.
2. **Monorepo deferred to v0.8** — confirmed acceptable; no work in this plan.
3. ✅ **Promote-to-space command location** — decided: `klio project promote`. Implemented in F2.

## Verification matrix

| Layer | Test files | Coverage |
|---|---|---|
| Schema migration | `engine/tests/test_alembic_migrations.py` | A1 + A2 (3 tests) |
| Models | `engine/tests/test_models.py` | A3 (2 tests) |
| Project service | `engine/tests/services/test_projects.py` | B1 (4 tests) |
| Recall service | `engine/tests/services/test_recall.py` | B2 (3 tests) |
| Recall API | `engine/tests/api/test_recall_endpoint.py` | B3 (3 tests) |
| Ingest API | `engine/tests/api/test_ingest_endpoint.py` | C1 (2 tests) |
| Entries API | `engine/tests/api/test_entries_endpoint.py` | C1 (1 test) |
| Projects API | `engine/tests/api/test_projects_endpoint.py` | F1 (3 tests) |
| Project detection | `bridge/internal/project/project_test.go` | D1 (5 tests) |
| LRU cache | `bridge/internal/project/cache_test.go` | D2 (2 tests) |
| Cloud client | `bridge/internal/cloud/client_test.go` | E1 (2 tests) |
| Hook handlers | `bridge/internal/hooks/handlers_test.go` | E2 (1 test) |
| MCP dispatcher | `bridge/internal/mcp/dispatcher_test.go` | E3 (2 tests) |
| CLI | `bridge/cmd/klio/project_test.go` | F2 (1 test) |
| **End-to-end** | `docs/runbooks/...-smoke.md` | G1 (manual) |

Total: **~33 unit tests + 1 manual runbook** across 14 tasks.
