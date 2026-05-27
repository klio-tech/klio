"""Entry write/read service with encryption + per-space embedding + dedup.

Embeddings are stored in shadow tables keyed by (entry_id) and selected
by the parent space's `embedding_dim`. The write path:

  1. Load the space, read its embedding_model + embedding_dim.
  2. Embed `content` with that model (via EmbeddingService).
  3. Validate the returned dim matches the space (defence in depth — the
     EmbeddingService already validates against the registry).
  4. Search the matching shadow for a near-duplicate within the same
     (user, space, kind). If hit, link old → new via superseded_by.
  5. Persist Entry, then INSERT the embedding into the shadow.

This means the entries table is dim-agnostic and one user can run
multiple spaces on different embedding models without schema changes.
"""
from __future__ import annotations

import json
import uuid

from sqlalchemy import text as sql_text
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.crypto.envelope import EnvelopeEncrypter
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.models.entry import Entry, EntryKind
from klio_engine.models.entry_embedding import SHADOW_BY_DIM
from klio_engine.models.space import Space
from klio_engine.models.user import User
from klio_engine.services.embedding_models import shadow_table_for
from klio_engine.services.embeddings import EmbeddingService


class EntryService:
    """Writes encrypted entries and reads decrypted entries."""

    def __init__(
        self,
        *,
        kms: KMSClient,
        embeddings: EmbeddingService,
        dedup_threshold: float = 0.92,
    ) -> None:
        self._kms = kms
        self._embeddings = embeddings
        self._dedup_threshold = dedup_threshold

    async def _envelope(
        self, session: AsyncSession, user_id: uuid.UUID
    ) -> EnvelopeEncrypter:
        u = await session.get(User, user_id)
        if u is None or u.wrapped_envelope_key is None:
            raise ValueError(f"user {user_id} has no envelope key")
        plaintext_key = self._kms.unwrap_envelope_key(u.wrapped_envelope_key)
        return EnvelopeEncrypter(envelope_key=plaintext_key)

    async def write(
        self,
        session: AsyncSession,
        *,
        user_id: uuid.UUID,
        space_id: uuid.UUID,
        agent_id: uuid.UUID,
        kind: EntryKind,
        content: str,
        metadata: dict | None = None,
        confidence: float = 1.0,
        session_id: uuid.UUID | None = None,
        project_id: uuid.UUID | None = None,
    ) -> Entry:
        space = await session.get(Space, space_id)
        if space is None or space.deleted_at is not None:
            raise ValueError(f"space {space_id} not found or deleted")

        envelope = await self._envelope(session, user_id)
        nonce, ct = envelope.encrypt(content.encode("utf-8"))
        meta_nonce = meta_ct = None
        if metadata:
            meta_nonce, meta_ct = envelope.encrypt(
                json.dumps(metadata).encode("utf-8")
            )

        embedding, spec = await self._embeddings.embed(
            content, model=space.embedding_model
        )
        # Defence-in-depth dim cross-check between the dispatch-layer
        # spec and the Space's pinned dim. Skipped when `spec.dim == 0`
        # — that's the dispatch-layer sentinel for `custom/*` routes
        # where the engine has no static knowledge of the upstream's
        # output dim. In that path, EmbeddingService's per-call
        # `_validate_dim` already enforces SUPPORTED_DIMS against the
        # actual response length, and the typed pgvector shadow column
        # selected via `SHADOW_BY_DIM[space.embedding_dim]` rejects any
        # length mismatch at INSERT time, so a wrong-dim response can't
        # silently land in the wrong shadow.
        if spec.dim and spec.dim != space.embedding_dim:
            raise ValueError(
                f"space {space_id} dim={space.embedding_dim} but model "
                f"{spec.name!r} produced dim={spec.dim}"
            )

        existing = await self._find_duplicate(
            session,
            user_id=user_id,
            space_id=space_id,
            kind=kind,
            embedding=embedding,
            dim=space.embedding_dim,
        )

        e = Entry(
            user_id=user_id,
            space_id=space_id,
            agent_id=agent_id,
            kind=kind,
            content_ciphertext=ct,
            content_nonce=nonce,
            metadata_ciphertext=meta_ct,
            metadata_nonce=meta_nonce,
            confidence=confidence,
            session_id=session_id,
            # v0.7.0 per-project scoping. NULL is the safe default —
            # NULL-tagged entries always surface in recall regardless of
            # the project filter (B2), so legacy + ad-hoc writes don't
            # silently disappear.
            project_id=project_id,
        )
        session.add(e)
        await session.flush()  # populate e.id

        shadow_cls = SHADOW_BY_DIM[space.embedding_dim]
        session.add(shadow_cls(entry_id=e.id, embedding=embedding, model=spec.name))
        await session.flush()

        if existing is not None:
            existing.superseded_by = e.id
            await session.flush()

        return e

    async def _find_duplicate(
        self,
        session: AsyncSession,
        *,
        user_id: uuid.UUID,
        space_id: uuid.UUID,
        kind: EntryKind,
        embedding: list[float],
        dim: int,
    ) -> Entry | None:
        emb_str = "[" + ",".join(repr(x) for x in embedding) + "]"
        shadow = shadow_table_for(dim)
        rows = await session.execute(
            sql_text(
                f"""
                SELECT e.id AS id,
                       s.embedding <=> CAST(:emb AS vector) AS distance
                FROM entries e
                JOIN {shadow} s ON s.entry_id = e.id
                WHERE e.user_id = :user_id
                  AND e.space_id = :space_id
                  AND e.kind::text = :kind
                  AND e.deleted_at IS NULL
                  AND e.superseded_by IS NULL
                ORDER BY distance
                LIMIT 1
                """
            ),
            {
                "user_id": user_id,
                "space_id": space_id,
                "kind": kind.value,
                "emb": emb_str,
            },
        )
        row = rows.first()
        if row is None:
            return None
        if (1.0 - row.distance) >= self._dedup_threshold:
            return await session.get(Entry, row.id)
        return None

    async def decrypt(
        self,
        session: AsyncSession,
        entry: Entry,
        user_id: uuid.UUID,
    ) -> tuple[str, dict | None]:
        envelope = await self._envelope(session, user_id)
        content = envelope.decrypt(
            entry.content_nonce, entry.content_ciphertext
        ).decode("utf-8")
        metadata = None
        if entry.metadata_ciphertext and entry.metadata_nonce:
            meta_bytes = envelope.decrypt(
                entry.metadata_nonce, entry.metadata_ciphertext
            )
            metadata = json.loads(meta_bytes.decode("utf-8"))
        return content, metadata
