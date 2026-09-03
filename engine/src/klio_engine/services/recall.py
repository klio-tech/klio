"""Recall service — semantic search with strict tenant isolation.

Embeds the query with the *space's* embedding model (not a global one),
then queries the matching shadow table joined to a tenant-scoped CTE on
entries. The CTE-before-HNSW pattern preserves the design-doc guarantee
that tenant boundaries are enforced before vector similarity ranking.

Every optional narrowing -- kind, project, agent -- belongs INSIDE that
CTE for the same reason: applied outside it, the planner is free to scan
the global vector index and post-filter, which is a tenant boundary
enforced after ranking rather than before.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.entry import Entry, EntryKind
from klio_engine.models.space import Space
from klio_engine.services.embedding_models import shadow_table_for
from klio_engine.services.embeddings import EmbeddingService


class RecallService:
    def __init__(self, *, embeddings: EmbeddingService) -> None:
        self._embeddings = embeddings

    async def recall(
        self,
        session: AsyncSession,
        *,
        user_id: uuid.UUID,
        space_id: uuid.UUID,
        query: str,
        kind: EntryKind | None = None,
        project_id: uuid.UUID | None = None,
        agent_id: uuid.UUID | None = None,
        limit: int = 10,
    ) -> list[tuple[Entry, float]]:
        space = await session.get(Space, space_id)
        if space is None or space.deleted_at is not None:
            return []

        embedding, _spec = await self._embeddings.embed(
            query, model=space.embedding_model
        )
        emb_str = "[" + ",".join(repr(x) for x in embedding) + "]"
        shadow = shadow_table_for(space.embedding_dim)

        # Tenant-isolated CTE: filter to (user_id, space_id) BEFORE the HNSW
        # search, so the planner can't accidentally scan the global vector
        # index and post-filter. Matches design doc guarantee #1.
        sql = f"""
            WITH scoped AS (
                SELECT e.id AS id, s.embedding AS embedding
                FROM entries e
                JOIN {shadow} s ON s.entry_id = e.id
                WHERE e.user_id = :user_id
                  AND e.space_id = :space_id
                  AND e.deleted_at IS NULL
                  AND e.superseded_by IS NULL
        """
        params: dict = {
            "user_id": user_id,
            "space_id": space_id,
            "emb": emb_str,
            "limit": limit,
        }
        if kind is not None:
            sql += " AND e.kind::text = :kind"
            params["kind"] = kind.value
        if agent_id is not None:
            # Opt-in agent isolation (`scope="agent"`). Entries always carry
            # a non-nullable agent_id, but recall filtered only on
            # (user_id, space_id) -- so one API key meant one shared pool
            # however many end users a consumer served, and agents surfaced
            # each other's memory. There is deliberately NO `OR agent_id IS
            # NULL` branch here: unlike project_id, the column cannot be
            # null, so a fallback would only re-open the leak.
            sql += " AND e.agent_id = :agent_id"
            params["agent_id"] = agent_id
        if project_id is not None:
            # NULL-tagged entries surface in every project's recall —
            # this is the safe default for legacy entries (written
            # before per-project tagging in v0.7.0) and entries from
            # non-detectable contexts (e.g. the bridge fired a hook
            # from a non-git, non-repo folder). See v0.7.0 design
            # doc §4: dropping the IS NULL branch would silently hide
            # all pre-0.7 memory the moment the bridge starts passing
            # a project filter — a worse user-visible regression than
            # the tiny cross-project bleed risk from untagged rows.
            sql += " AND (e.project_id = :project_id OR e.project_id IS NULL)"
            params["project_id"] = project_id
        sql += """
            )
            SELECT id, embedding <=> CAST(:emb AS vector) AS distance
            FROM scoped
            ORDER BY distance
            LIMIT :limit
        """

        rows = (await session.execute(text(sql), params)).all()
        ids = [r.id for r in rows]
        if not ids:
            return []
        entries = {
            e.id: e
            for e in (
                await session.execute(select(Entry).where(Entry.id.in_(ids)))
            ).scalars()
        }
        return [(entries[r.id], 1.0 - r.distance) for r in rows]
