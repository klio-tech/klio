"""Per-space embedding model + shadow tables.

Replaces the single `entries.embedding vector(1536)` column with three
per-dim shadow tables (`entry_embeddings_768`, `entry_embeddings_1024`,
`entry_embeddings_1536`) and locks each space to one model.

Why shadows: pgvector requires fixed-dim columns, so the old design
forced every space on every Klio deployment to use the same embedding
model. The shadow design lets one user run different models in different
spaces — e.g. nomic-embed-text (768) for cheap recall, openai 3-small
(1536) for high-quality.

Why immutable embeddings: the audit chain is append-only. Re-embedding an
existing row would mutate it and break downstream notarization. Shadows
let `klio reembed` write a *new* embedding row alongside the old one
(during the migration window) without touching the entry itself.

Existing entries are dropped because:
  - Pre-migration entries used the old 1536-dim stub, which has no
    semantic value (it's a hash, not a real embedding).
  - The dev/local DB this targets has no production data.
  - There is no production deployment yet (per HANDOFF.md, Phase L items
    flagged "external accounts / billing" remain open).
This migration is therefore safe-by-construction for our current state.
A future migration after first-customer launch must back-fill instead.
"""
from collections.abc import Sequence
from typing import Union

from alembic import op


revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Drop legacy data and the old 1536-d column. Existing audit rows
    # remain valid (entries.id is unchanged); only the embeddings —
    # which were stub-quality anyway — are forfeited.
    op.execute("DROP INDEX IF EXISTS ix_entries_embedding_hnsw")
    op.execute("DELETE FROM entries")
    op.execute("ALTER TABLE entries DROP COLUMN IF EXISTS embedding")

    # Lock each space to a model + dim. Defaults exist so existing spaces
    # in the dev DB are valid post-migration; new code paths require a
    # caller to set these explicitly via the spaces API.
    op.execute(
        """
        ALTER TABLE spaces
            ADD COLUMN embedding_model VARCHAR(120)
                NOT NULL DEFAULT 'ollama/nomic-embed-text',
            ADD COLUMN embedding_dim INTEGER
                NOT NULL DEFAULT 768
        """
    )

    for dim in (768, 1024, 1536):
        op.execute(
            f"""
            CREATE TABLE entry_embeddings_{dim} (
                entry_id UUID PRIMARY KEY
                    REFERENCES entries(id) ON DELETE CASCADE,
                embedding vector({dim}) NOT NULL,
                model VARCHAR(120) NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        op.execute(
            f"""
            CREATE INDEX ix_entry_embeddings_{dim}_hnsw
                ON entry_embeddings_{dim}
                USING hnsw (embedding vector_cosine_ops)
                WITH (m = 16, ef_construction = 64)
            """
        )
        op.execute(
            f"""
            CREATE INDEX ix_entry_embeddings_{dim}_model
                ON entry_embeddings_{dim} (model)
            """
        )


def downgrade() -> None:
    for dim in (1536, 1024, 768):
        op.execute(f"DROP INDEX IF EXISTS ix_entry_embeddings_{dim}_model")
        op.execute(f"DROP INDEX IF EXISTS ix_entry_embeddings_{dim}_hnsw")
        op.execute(f"DROP TABLE IF EXISTS entry_embeddings_{dim}")
    op.execute(
        """
        ALTER TABLE spaces
            DROP COLUMN IF EXISTS embedding_dim,
            DROP COLUMN IF EXISTS embedding_model
        """
    )
    op.execute("ALTER TABLE entries ADD COLUMN embedding vector(1536)")
    op.execute(
        "CREATE INDEX ix_entries_embedding_hnsw ON entries "
        "USING hnsw (embedding vector_cosine_ops) "
        "WITH (m = 16, ef_construction = 64) "
        "WHERE deleted_at IS NULL AND superseded_by IS NULL"
    )
