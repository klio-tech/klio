"""Re-embed all entries in a space under a new embedding model.

The flow:
    decrypt entry content using the user's envelope key
    -> embed with the *new* model
    -> validate dim matches the new model's registry entry
    -> if new dim == old dim: UPDATE the existing shadow row
       (so HNSW maintenance stays in one table)
    -> if new dim != old dim: INSERT into the new dim's shadow,
       then DELETE from the old shadow (keeps each entry in
       exactly one shadow table at all times)
    -> after every entry processed, atomically swap
       spaces.embedding_model + spaces.embedding_dim

Critically, this never mutates the `entries` table itself, so the audit
chain over entries remains valid after a re-embed. Shadow tables are
operational data, not chained data.

Operates in chunks of `chunk_size` entries; commits between chunks so a
mid-flight crash leaves a half-migrated space in a recoverable state
(re-running the same reembed call resumes naturally because already-new
shadow rows compare equal and are no-ops).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import delete as sql_delete
from sqlalchemy import select, text as sql_text
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.audit.writer import write_audit_event
from klio_engine.crypto.envelope import EnvelopeEncrypter
from klio_engine.crypto.kms_client import KMSClient
from klio_engine.models.entry import Entry
from klio_engine.models.entry_embedding import SHADOW_BY_DIM
from klio_engine.models.space import Space
from klio_engine.models.user import User
from klio_engine.services.embedding_models import resolve as resolve_embed_model
from klio_engine.services.embeddings import EmbeddingService


@dataclass
class ReembedResult:
    space_id: uuid.UUID
    from_model: str
    from_dim: int
    to_model: str
    to_dim: int
    entries_processed: int


async def reembed_space(
    session: AsyncSession,
    *,
    kms: KMSClient,
    embeddings: EmbeddingService,
    user_id: uuid.UUID,
    actor_agent_id: uuid.UUID,
    space_id: uuid.UUID,
    to_model: str,
    chunk_size: int = 64,
) -> ReembedResult:
    space = await session.get(Space, space_id)
    if space is None or space.deleted_at is not None:
        raise ValueError(f"space {space_id} not found or deleted")
    if space.user_id != user_id:
        raise PermissionError(
            f"space {space_id} is not owned by user {user_id}"
        )

    new_spec = resolve_embed_model(to_model)
    old_model, old_dim = space.embedding_model, space.embedding_dim

    if new_spec.name == old_model and new_spec.dim == old_dim:
        return ReembedResult(
            space_id=space_id,
            from_model=old_model,
            from_dim=old_dim,
            to_model=new_spec.name,
            to_dim=new_spec.dim,
            entries_processed=0,
        )

    user = await session.get(User, user_id)
    if user is None or user.wrapped_envelope_key is None:
        raise ValueError(f"user {user_id} has no envelope key")
    envelope = EnvelopeEncrypter(
        envelope_key=kms.unwrap_envelope_key(user.wrapped_envelope_key)
    )

    old_shadow = SHADOW_BY_DIM[old_dim]
    new_shadow = SHADOW_BY_DIM[new_spec.dim]
    same_shadow = old_dim == new_spec.dim

    processed = 0
    last_id: uuid.UUID | None = None
    while True:
        q = (
            select(Entry)
            .where(
                Entry.space_id == space_id,
                Entry.user_id == user_id,
                Entry.deleted_at.is_(None),
            )
            .order_by(Entry.id)
            .limit(chunk_size)
        )
        if last_id is not None:
            q = q.where(Entry.id > last_id)
        chunk = (await session.execute(q)).scalars().all()
        if not chunk:
            break

        for entry in chunk:
            content = envelope.decrypt(
                entry.content_nonce, entry.content_ciphertext
            ).decode("utf-8")
            vector, _ = await embeddings.embed(content, model=new_spec.name)

            if same_shadow:
                # Update the existing row: model + embedding swap.
                await session.execute(
                    sql_text(
                        f"""
                        UPDATE {old_shadow.__tablename__}
                        SET embedding = CAST(:emb AS vector),
                            model = :model
                        WHERE entry_id = :eid
                        """
                    ),
                    {
                        "emb": "[" + ",".join(repr(x) for x in vector) + "]",
                        "model": new_spec.name,
                        "eid": entry.id,
                    },
                )
            else:
                # Insert into new shadow first (idempotent on PK conflict)
                # then drop the old shadow row.
                session.add(
                    new_shadow(
                        entry_id=entry.id,
                        embedding=vector,
                        model=new_spec.name,
                    )
                )
                await session.flush()
                await session.execute(
                    sql_delete(old_shadow).where(
                        old_shadow.entry_id == entry.id
                    )
                )

            processed += 1
            last_id = entry.id

        await session.commit()
        # Refresh ORM state — `space` is detached after commit.
        space = await session.get(Space, space_id)
        if space is None:
            raise RuntimeError("space disappeared mid-reembed")

    space.embedding_model = new_spec.name
    space.embedding_dim = new_spec.dim
    await write_audit_event(
        session,
        user_id=user_id,
        actor_type="agent",
        actor_id=actor_agent_id,
        action="space.reembed",
        target_type="space",
        target_id=space_id,
        metadata={
            "from_model": old_model,
            "from_dim": old_dim,
            "to_model": new_spec.name,
            "to_dim": new_spec.dim,
            "entries_processed": processed,
        },
    )
    await session.commit()

    return ReembedResult(
        space_id=space_id,
        from_model=old_model,
        from_dim=old_dim,
        to_model=new_spec.name,
        to_dim=new_spec.dim,
        entries_processed=processed,
    )
