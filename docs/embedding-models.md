# Embedding Models in Klio

Klio uses pluggable embedding models. Each **space** (a user-named
container of entries) is pinned to one model at creation time. Different
spaces can use different models; the database maintains a per-dim
**shadow table** for each supported dimension and a write to a space
goes to the shadow that matches the space's pinned dim.

This means you can self-host a memory store on a small laptop with the
free 768-dim `nomic-embed-text`, while a colleague on the same Klio
deployment uses 1536-dim OpenAI embeddings — without a schema change.

---

## Supported models out of the box

| Name (set as `KLIO_EMBEDDING_MODEL`) | Dim | Provider | License | Notes |
|---|---|---|---|---|
| `ollama/nomic-embed-text` *(default)* | 768 | Ollama (local) | Apache 2.0 | 274 MB on disk, 8 K context. Best balance of quality and footprint. |
| `ollama/mxbai-embed-large` | 1024 | Ollama (local) | Apache 2.0 | 670 MB, 512-token context (short!). Higher MTEB than nomic. |
| `ollama/snowflake-arctic-embed2` | 1024 | Ollama (local) | Apache 2.0 | ~1.2 GB, 8 K context, multilingual, SOTA among open weights. |
| `ollama/bge-m3` | 1024 | Ollama (local) | MIT | ~2.2 GB, dense+sparse+colbert, best multilingual. Heavy. |
| `text-embedding-3-small` | 1536 | OpenAI | proprietary | Requires `OPENAI_API_KEY`. Highest quality currently available. |
| `text-embedding-ada-002` | 1536 | OpenAI | proprietary | Legacy. Prefer `3-small`. |
| `stub` | 1536 | internal | n/a | Deterministic SHA-256-based fake. **Only for tests** — semantic similarity is meaningless. |

Add a new model:

1. Append a row to `EMBEDDING_MODELS` in [embedding_models.py](../engine/src/klio_engine/services/embedding_models.py).
2. The dim must be one of `(768, 1024, 1536)`. If it isn't, also extend the migration to add a new shadow table — see "Adding a new dim" below.

---

## Per-space pinning

Every space has two columns:

```sql
spaces.embedding_model TEXT NOT NULL  -- e.g. 'ollama/nomic-embed-text'
spaces.embedding_dim   INTEGER NOT NULL  -- e.g. 768
```

These are set at space creation time and immutable thereafter unless you
explicitly run `klio reembed` (see below). The pin is honored on every
read and write; the embedding service refuses to write a vector whose
dim does not match the registry's expectation for the model.

### Why per-space and not per-deployment?

- Different users want different cost/quality trade-offs.
- The audit chain over `entries` is append-only. A model upgrade that
  re-embeds in place would mutate historical rows and break notarization.
  Shadows are operational data outside the chain.
- Multi-tenant SaaS can offer "premium" spaces backed by OpenAI embeddings
  alongside "free" spaces backed by local models.

---

## Shadow tables

```
entries (id, user_id, space_id, ...)            -- no embedding column
entry_embeddings_768  (entry_id PK, embedding vector(768),  model, ...)
entry_embeddings_1024 (entry_id PK, embedding vector(1024), model, ...)
entry_embeddings_1536 (entry_id PK, embedding vector(1536), model, ...)
```

Each shadow has its own HNSW index. The recall path joins the shadow
matching the space's dim:

```sql
WITH scoped AS (
    SELECT e.id, s.embedding
    FROM entries e
    JOIN entry_embeddings_768 s ON s.entry_id = e.id
    WHERE e.user_id = $1 AND e.space_id = $2 AND e.deleted_at IS NULL
)
SELECT id, embedding <=> $3 AS distance
FROM scoped
ORDER BY distance LIMIT 10;
```

The `WITH scoped AS` CTE filters tenant rows **before** the HNSW query,
so the planner cannot accidentally scan the global vector index across
tenants.

---

## Switching models on an existing space (`klio reembed`)

To switch a space from `nomic-embed-text` (768) to
`snowflake-arctic-embed2` (1024):

```bash
/tmp/klio reembed --space default --to ollama/snowflake-arctic-embed2
```

What happens:

1. CLI calls `POST /v1/spaces/{id}/reembed` (admin scope required).
2. Engine streams entries in 64-row chunks. For each entry:
   - Decrypt content via the user's envelope key.
   - Embed with the new model.
   - If the new dim equals the old: `UPDATE entry_embeddings_{dim}`.
   - Else: `INSERT entry_embeddings_{newdim}`, then
     `DELETE entry_embeddings_{olddim}` for that entry.
3. Atomic-ish swap of `spaces.embedding_model` and `spaces.embedding_dim`
   at the end. Crash mid-flight is recoverable: re-running picks up
   where it left off because the write to the new shadow is idempotent
   on PK conflict.
4. One audit row per re-embed under `space.reembed`.

**Cost.** Re-embedding goes through the LLM, so it is bounded by Ollama
or external API throughput. With Ollama on CPU, expect ~5-15 entries/sec
for 768-dim models; ~1-3 entries/sec for 1024-dim models.

---

## Adding a new dim

Suppose OpenAI ships a 4096-dim embedding next year:

1. Add `EmbeddingModelSpec("text-embedding-4-large", 4096, "openai")` to
   `EMBEDDING_MODELS`.
2. Add `4096` to `SUPPORTED_DIMS`.
3. Add `EntryEmbedding4096` to
   [entry_embedding.py](../engine/src/klio_engine/models/entry_embedding.py)
   and register it in `SHADOW_BY_DIM`.
4. New Alembic migration:
   ```sql
   CREATE TABLE entry_embeddings_4096 (
       entry_id UUID PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
       embedding vector(4096) NOT NULL,
       model VARCHAR(120) NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );
   CREATE INDEX ix_entry_embeddings_4096_hnsw ON entry_embeddings_4096
       USING hnsw (embedding vector_cosine_ops)
       WITH (m = 16, ef_construction = 64);
   ```
5. Existing spaces are untouched. New spaces created with the new model
   automatically pick up dim 4096.

---

## Local development quickstart

```bash
make first-run     # docker compose up + ollama-pull + alembic upgrade + go build
make engine        # FastAPI engine in foreground, talking to Ollama
/tmp/klio init     # provision an account + patch ~/.claude
/tmp/klio daemon & # background daemon
```

Verify with the integration tests:

```bash
make test-ollama
```

If the test reports a missing model, run `make ollama-pull` first.
