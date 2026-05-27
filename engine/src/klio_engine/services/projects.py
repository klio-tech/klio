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
IntegrityError. We wrap the flush in a SAVEPOINT (`session.begin_nested()`)
so only the failed INSERT is rolled back; the caller's outer
transaction stays alive. After the SAVEPOINT rollback we re-find the
winning row — guaranteed visible because the concurrent insert
committed before our IntegrityError fired.

F1 — `promote()` is the escape-valve method: it elevates a project
from "tagged inside the default space" to "owns a dedicated space"
in one of two modes:
  - assign an existing space (caller supplies space_id)
  - create a new space pinned to a chosen embedding model
The caller (handler) must validate the XOR invariant before calling.
"""
from __future__ import annotations

import uuid

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.permission import Permission, PermissionScope
from klio_engine.models.project import Project
from klio_engine.models.space import Space
from klio_engine.services.embedding_models import resolve as resolve_embed_model


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
            # DB-side now() rather than Python datetime.now(): the DB
            # clock is the single source of truth for ordering. With
            # Python clocks, two bridge processes on machines with NTP
            # skew could write timestamps that go backwards relative to
            # actual observation order — breaking any "sort by recency"
            # UI.
            existing.last_seen_at = func.now()
            return existing

        project = Project(
            user_id=user_id,
            git_remote=git_remote,
            repo_root_path=repo_root_path,
            display_name=display_name,
        )
        try:
            # SAVEPOINT-scoped INSERT. AsyncSession.rollback() would
            # roll back the WHOLE outer transaction — destroying any
            # pending writes the caller (e.g. the bridge tagging an
            # already-created Entry row) made before invoking ensure().
            # begin_nested() issues a PG SAVEPOINT and unconditionally
            # flushes pre-existing pending state to it first, so the
            # caller's prior writes go into the savepoint scope too.
            # The add() + flush() of OUR row happens inside the
            # savepoint, so on IntegrityError we ROLLBACK TO SAVEPOINT
            # (releasing only OUR failed INSERT while preserving the
            # already-flushed pending state from the outer tx).
            async with session.begin_nested():
                session.add(project)
                await session.flush()
        except IntegrityError:
            # Concurrent insert won the race. The SAVEPOINT scoped the
            # rollback to just our failed INSERT — the outer
            # transaction (and any other pending changes the caller
            # made before invoking ensure()) is intact. Re-find the
            # winning row.
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
            again.last_seen_at = func.now()
            return again
        return project

    async def promote(
        self,
        session: AsyncSession,
        *,
        user_id: uuid.UUID,
        agent_id: uuid.UUID,
        project_id: uuid.UUID,
        space_id: uuid.UUID | None,
        embedding_model: str | None,
    ) -> Project:
        """Set `project.dedicated_space_id` to an existing space or a
        newly-created one.

        The caller (handler) must enforce the XOR invariant — exactly
        one of `space_id` / `embedding_model` set — before calling.
        We assert it here as defense-in-depth: a future internal caller
        that forgets the pre-check gets a clear ValueError rather than
        silently writing whichever field is non-None.

        `agent_id` is required so the new-space branch can grant the
        promoting agent admin scope on the freshly-created Space. Without
        the grant, every subsequent write tagged with that project_id
        would be 403'd by the ACL check_permission gate (which sources
        truth from the `permissions` table, not from `space.user_id`).

        Promotion is a one-shot operation: a project already pinned to a
        dedicated space cannot be re-promoted. Allowing it would silently
        orphan the previous dedicated space (no caller would clean it up)
        AND collide on the deterministic `dedicated-<project_id>` slug in
        the new-space branch, surfacing as an IntegrityError → 500. The
        409 surfaces the conflict to the caller so they can either accept
        the existing dedicated_space_id or (when a future demote endpoint
        lands) unpin first. The check runs AFTER the ownership lookup so
        a cross-tenant probe still gets the no-leak 404.

        Raises (let the handler translate to HTTP):
          - HTTPException(404, "project not found") if `project_id`
            doesn't exist OR isn't owned by `user_id`. 404 not 403
            because leaking row existence across tenants is the more
            damaging failure mode.
          - HTTPException(409, "already promoted ...") if the project
            already has a `dedicated_space_id` set.
          - HTTPException(404, "space not found") if `space_id` is
            supplied but doesn't exist OR isn't owned by `user_id`.
          - HTTPException(422, "<reason>") if `embedding_model` is
            supplied but unknown to the registry. `resolve()` raises
            ValueError; we convert here so the handler stays thin.

        Returns the mutated Project. The caller commits.
        """
        if (space_id is None) == (embedding_model is None):
            # Defense-in-depth: caller's pre-check should have rejected.
            raise ValueError(
                "promote() requires exactly one of space_id or embedding_model"
            )

        project = (
            await session.execute(
                select(Project).where(
                    Project.id == project_id,
                    Project.user_id == user_id,
                )
            )
        ).scalar_one_or_none()
        if project is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "project not found"
            )

        # Re-promote guard. Placed AFTER the ownership lookup so a
        # cross-tenant probe of a known-promoted project still gets
        # the no-leak 404 rather than a 409 that confirms the project
        # exists.
        if project.dedicated_space_id is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                (
                    f"project {project_id} is already promoted to "
                    f"space {project.dedicated_space_id}"
                ),
            )

        if space_id is not None:
            # Existing-space path: validate the space exists, belongs
            # to this user, and is not soft-deleted. Reuse the same
            # ownership + deleted_at filters that `/v1/spaces/{id}`
            # uses (see `api/spaces.py::_load_owned_space`) so this
            # endpoint can't be used to attach a project to a soft-
            # deleted space.
            space = (
                await session.execute(
                    select(Space).where(
                        Space.id == space_id,
                        Space.user_id == user_id,
                        Space.deleted_at.is_(None),
                    )
                )
            ).scalar_one_or_none()
            if space is None:
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND, "space not found"
                )
            project.dedicated_space_id = space_id
            return project

        # New-space path: resolve the embedding model through the
        # registry. `resolve()` raises ValueError on unknown names;
        # convert to 422 with the original message so the user sees
        # "Unknown embedding model 'xyz'. Add a row..." rather than a
        # 500.
        try:
            spec = resolve_embed_model(embedding_model)
        except ValueError as e:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)
            ) from e

        new_space = Space(
            user_id=user_id,
            name=f"{project.display_name} (dedicated)",
            # Slug must be unique per (user_id, slug); use the project
            # UUID for uniqueness (display_name slugs could collide for
            # users with multiple projects sharing a basename, or with
            # an already-named space). `dedicated-<project_uuid>` is
            # deterministic, idempotent on retry, and never overlaps
            # with user-created slugs (which never contain a UUID).
            slug=f"dedicated-{project_id}",
            embedding_model=spec.name,
            embedding_dim=spec.dim,
        )
        session.add(new_space)
        await session.flush()

        # Grant the promoting agent admin scope on the new space.
        # Without this row, check_permission (services/acl.py) raises
        # ACLDeniedError on every subsequent write to the dedicated
        # space — the bridge would happily tag entries with the
        # project_id, the API would 403 them, and the failure would
        # only be visible at write time. Mirrors the create_space grant
        # in `api/spaces.py`. `granted_by_agent_id=agent_id` records
        # the promoting agent as the grantor (self-grant on creation,
        # same convention as provisioning's bootstrap grant).
        permission = Permission(
            user_id=user_id,
            space_id=new_space.id,
            agent_id=agent_id,
            scope=PermissionScope.ADMIN,
            granted_by_agent_id=agent_id,
        )
        session.add(permission)
        await session.flush()

        project.dedicated_space_id = new_space.id
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
