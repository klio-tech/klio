"""Recall service — semantic search with strict tenant isolation."""
import uuid

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.models.entry import Entry, EntryKind
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
        embedding = await self._embeddings.embed(query)
        emb_str = "[" + ",".join(repr(x) for x in embedding) + "]"

        # Tenant-isolated CTE: filter to (user_id, space_id) BEFORE the HNSW
        # search, so the planner can't accidentally scan the global vector
        # index and post-filter. This is hard guarantee #1 from the design doc.
        sql = """
            WITH scoped AS (
                SELECT id, embedding
                FROM entries
                WHERE user_id = :user_id
                  AND space_id = :space_id
                  AND deleted_at IS NULL
                  AND superseded_by IS NULL
        """
        params: dict = {
            "user_id": user_id,
            "space_id": space_id,
            "emb": emb_str,
            "limit": limit,
        }
        if kind is not None:
            sql += " AND kind::text = :kind"
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
