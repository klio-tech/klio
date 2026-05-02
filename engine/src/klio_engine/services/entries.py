"""Entry write/read service with encryption + embedding + dedup."""
import json
import uuid

from sqlalchemy import text as sql_text
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.crypto.envelope import EnvelopeEncrypter
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.models.entry import Entry, EntryKind
from klio_engine.models.user import User
from klio_engine.services.embeddings import EmbeddingService


class EntryService:
    """Writes encrypted entries and reads decrypted entries.

    Flow on write:
      1. Load user envelope key (unwrap via KMS).
      2. Encrypt content + metadata.
      3. Embed plaintext content.
      4. Search recent same-kind entries in same space; if cosine sim >=
         dedup_threshold, link old entry to new via superseded_by.
      5. Persist row.
    """

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
    ) -> Entry:
        envelope = await self._envelope(session, user_id)
        nonce, ct = envelope.encrypt(content.encode("utf-8"))
        meta_nonce = meta_ct = None
        if metadata:
            meta_nonce, meta_ct = envelope.encrypt(
                json.dumps(metadata).encode("utf-8")
            )

        embedding = await self._embeddings.embed(content)

        existing = await self._find_duplicate(
            session,
            user_id=user_id,
            space_id=space_id,
            kind=kind,
            embedding=embedding,
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
            embedding=embedding,
            confidence=confidence,
            session_id=session_id,
        )
        session.add(e)
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
    ) -> Entry | None:
        emb_str = "[" + ",".join(repr(x) for x in embedding) + "]"
        rows = await session.execute(
            sql_text(
                """
                SELECT id, embedding <=> CAST(:emb AS vector) AS distance
                FROM entries
                WHERE user_id = :user_id
                  AND space_id = :space_id
                  AND kind::text = :kind
                  AND deleted_at IS NULL
                  AND superseded_by IS NULL
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
        # cosine distance = 1 - cosine sim
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
