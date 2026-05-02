"""Recall service — semantic search with strict tenant isolation.

Embeds the query with the *space's* embedding model (not a global one),
then queries the matching shadow table joined to a tenant-scoped CTE on
entries. The CTE-before-HNSW pattern preserves the design-doc guarantee
that tenant boundaries are enforced before vector similarity ranking.
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
