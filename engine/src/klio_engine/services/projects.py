"""Get-or-create projects with partial-unique-index semantics.

The bridge sends (remote, repo_root_path, display_name) on every
write that needs tagging. This service is the single place that
deduplicates:
  - same git_remote → same project (canonical when remote is present;
    survives multiple checkouts of the same repo to different paths)
  - same repo_root_path → same project (fallback when no git remote;
    the partial-unique-index design at migration 0008 enforces this)

Bumps `last_seen_at` on every observation so a future "active
projects" UI can sort by recency.

Race handling: under concurrent writes from two bridge processes (or
two hook fires that happen to land on the same project simultaneously),
both may pass the `_find` check and try to INSERT. The second
INSERT collides with the partial unique index → SQLAlchemy raises
IntegrityError. We catch that, rollback, and re-find — guaranteed to
succeed because the winning concurrent insert is now visible.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.project import Project


class ProjectService:
    """Resolve `(remote, repo_root_path)` → `Project` row, creating
    one on first observation and bumping `last_seen_at` thereafter.

    Stateless — instances exist only for dependency-injection
    convenience. Safe to construct per-request.
    """

    async def ensure(
        self,
        session: AsyncSession,
        *,
        user_id: uuid.UUID,
        git_remote: str | None,
        repo_root_path: str | None,
        display_name: str,
    ) -> Project:
        """Get-or-create the project row.

        Resolution order (matches migration 0008's partial-unique-
        index semantics):
          - if `git_remote` is present, dedupe on `(user_id, git_remote)`
          - else if `repo_root_path` is present, dedupe on
            `(user_id, repo_root_path)` AND `git_remote IS NULL`
          - else this is an error (the bridge MUST supply at least one)

        On hit, `last_seen_at` is bumped to `now()` and the existing row
        returned. On miss, a new row is inserted and returned. Under
        concurrent inserts, IntegrityError triggers a rollback + retry.
        """
        if git_remote is None and repo_root_path is None:
            raise ValueError(
                "ensure() requires at least one of git_remote or repo_root_path"
            )

        existing = await self._find(
            session,
            user_id=user_id,
            git_remote=git_remote,
            repo_root_path=repo_root_path,
        )
        if existing is not None:
            existing.last_seen_at = datetime.now(timezone.utc)
            return existing

        project = Project(
            user_id=user_id,
            git_remote=git_remote,
            repo_root_path=repo_root_path,
            display_name=display_name,
        )
        session.add(project)
        try:
            await session.flush()
        except IntegrityError:
            # Concurrent insert won the race. Roll back the failed
            # INSERT and re-find — the winning row is now visible.
            await session.rollback()
            again = await self._find(
                session,
                user_id=user_id,
                git_remote=git_remote,
                repo_root_path=repo_root_path,
            )
            if again is None:
                # Genuinely unexpected — the row that triggered the
                # IntegrityError vanished. Re-raise the original.
                raise
            again.last_seen_at = datetime.now(timezone.utc)
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
        """Look up an existing project row by the same key the
        ensure-side uniqueness expects. Returns None on miss.

        Query patterns intentionally mirror the partial unique indexes
        on `projects` (migration 0008): both go (user_id, <key>), so
        the existing composite indexes serve them as left-prefixes
        without needing a standalone `user_id` index.
        """
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
