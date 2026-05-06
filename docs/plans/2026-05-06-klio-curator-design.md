# Klio Curator — design

**Date:** 2026-05-06
**Status:** Approved, ready for implementation plan
**Target release:** `0.5.0`

## Why this exists

Today every PostToolUse fires `klio hook post-tool`, which writes an
`observation` entry into the user's Klio space. That gives `recall` a
firehose of mechanical events ("Used tool Bash …", "Used tool Read …")
but nothing semantic — no durable preferences, no decisions, no plans.

Asking Claude to call `mcp__klio__remember` / `note` / `decide`
mid-conversation is unreliable: instructional rules in `CLAUDE.md`
help bias the behaviour, but a busy session forgets, and there is no
deterministic gate. A user finishes a four-hour pairing session in
which they decided the deploy target, taught Claude their package
manager preference, and outlined a refactor — and none of it persists.

The curator closes that gap server-side: a background async job
inside the engine container that reads recent observations on a
schedule, asks the existing `FactExtractor` to lift durable
facts / decisions / plans / notes out of the firehose, and writes
those back as proper Klio entries. The mechanical observations stay
where they are (the audit chain stays intact); the synthesised
entries become first-class memories that `recall` can surface.

This trades a small amount of LLM cost on a slow schedule for
deterministic memory accumulation that does not depend on Claude
remembering to call any tool.

## Goal

Ship a background curator inside `klio-engine` that:

1. Reads `kind=observation` entries written since the last cursor
   for each user, on a configurable schedule.
2. Hands batches to `services/extractor.py:FactExtractor` — the
   exact module the bridge already uses for in-line extraction —
   to produce typed `ExtractedEntry` items.
3. Writes those items back as `kind ∈ {memory, decision, plan, note}`
   entries with `metadata.sources = [<observation_uuid>, ...]` for
   provenance, embedded into the user's default space, audit-chained.
4. Advances a per-user cursor only after the batch commits.

Operationally, the curator must be:

- **Surfaced during `klio init`** as a single yes / no prompt with
  sane defaults (every hour, the same model the user already picked
  for extraction). One keypress for the median user.
- **Reconfigurable without re-running `init`** via a new
  `klio update` top-level subcommand that re-prompts only the slice
  the user wants to change and restarts the affected container —
  no image pulls, no provisioning, no agent re-detection.
- **Local-first.** No new outbound traffic except to the user's
  already-configured LLM provider (Ollama on the host, OpenRouter,
  or the user's custom endpoint).
- **Idempotent and crash-safe.** A partial run never loses
  observations; the cursor only moves on a successful commit.

Out of scope for v1 (intentional, see "Out of scope" below): a
public REST endpoint for triggering curation, cross-user curation,
per-space curator config, a dashboard view of "what the curator
did this week."

## Architecture

```
                                  ┌───────────────────────────┐
                                  │     klio-engine container │
                                  │                           │
   PostToolUse hook ──obs──▶ entries(observation) ──┐         │
                                  │                  │         │
                                  │     ┌────────────▼──────┐  │
                                  │     │ Curator (new)     │  │
              every N hours ──────┼────▶│  read since cursor│  │
                                  │     │  → FactExtractor  │  │
                                  │     │  → write entries  │  │
                                  │     │  → advance cursor │  │
                                  │     └────────┬──────────┘  │
                                  │              │             │
                                  │              ▼             │
                                  │    entries(memory|decision │
                                  │            |plan|note)     │
                                  └───────────────────────────┘
```

**Where it lives.** APScheduler async job inside the existing
`klio-engine` FastAPI process. The job is registered at engine
startup (FastAPI lifespan) and cancelled at shutdown. No new
container, no host cron, no extra IPC. The same Python imports the
extractor + embedder + audit chain already use.

**What it reuses.** `services/extractor.py:FactExtractor` for
classification (already supports stub / Ollama / OpenRouter / custom
backends, already returns `list[ExtractedEntry]` in the right
shape). `services/embeddings.py` for embedding the synthesised
entries into the per-space shadow tables. `services/entries.py` for
the encrypted-write + audit-chain path — the curator writes through
the same service the API uses, no shortcut.

**Why not a new container.** A separate `klio-curator` service
would mean a second Python image, a second pip install, a second
healthcheck, a second log stream the user has to know about.
APScheduler in the engine is one process, one image, one log. We
can split it out later if the workload outgrows the engine's
resource budget — the cursor-driven contract makes that refactor
mechanical (move the same code to a new container, point at the
same Postgres).

**Why not the bridge ticker (Go).** The bridge already has a
`time.Ticker` in `internal/daemon/ticker.go`, but moving curation
into Go means re-implementing the prompt-routing + LLM-dispatch
logic that already lives in `services/extractor.py`. The Python
version is the source of truth and stays that way.

## Schema

One new table. No changes to `entries`, `audit_log`, or any
existing table.

```sql
CREATE TABLE curator_state (
    user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_run_at    TIMESTAMPTZ,
    last_cursor_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01 00:00:00+00',
    runs_count     INTEGER     NOT NULL DEFAULT 0,
    last_error     TEXT,
    last_synthesized INTEGER   NOT NULL DEFAULT 0
);
```

- **`last_cursor_at`** — the high-water mark on `entries.created_at`
  for `kind=observation`. The curator reads strictly-greater-than.
- **`last_run_at`** — wall-clock of the most recent attempt
  (success or failure). Surfaces in `klio status`.
- **`runs_count`** — monotonic. Useful for tests and for
  user-visible "the curator has run 47 times" telemetry.
- **`last_error`** — null on success, the last exception message on
  failure. The curator does not retry inside a single tick — it
  records and waits for the next.
- **`last_synthesized`** — number of entries written in the most
  recent successful run. Surfaces in `klio status`.

Per-user row: created lazily on the first curator tick for that
user. The migration that adds the table does not back-fill rows;
each user gets a row when they first own observations.

Synthesised entries reuse the existing `entries.metadata` JSONB
column. The curator writes:

```json
{
  "sources": ["<observation_uuid>", ...],
  "curator_run_id": "<uuid>",
  "synthesised_at": "<rfc3339>",
  "extractor_backend": "ollama"
}
```

— enough for trust ("how do you know I prefer Bun?") and for future
supersedes computation, with no schema migration.

## Config

The curator reads four env vars from the engine container:

| Env var | Default | Surfaced where |
|---|---|---|
| `KLIO_CURATOR_ENABLED` | `true` | `klio init` (single Y/n) |
| `KLIO_CURATOR_INTERVAL_SECS` | `3600` | `klio update curator` |
| `KLIO_CURATOR_MODEL` | inherits `KLIO_EXTRACTION_MODEL` | `klio update curator` |
| `KLIO_CURATOR_BATCH_SIZE` | `50` | never (internal tuning constant) |

`KLIO_CURATOR_MODEL` follows the same prefix routing as
`KLIO_EXTRACTION_MODEL`: `ollama/<model>`, `openrouter/<vendor>/<model>`,
`custom/<model>`, or `stub`. When unset, the curator falls back to
the extraction model so the median user gets sensible defaults
without being asked twice.

The compose template gains one block on the engine service:

```yaml
KLIO_CURATOR_ENABLED: "${KLIO_CURATOR_ENABLED:-true}"
KLIO_CURATOR_INTERVAL_SECS: "${KLIO_CURATOR_INTERVAL_SECS:-3600}"
KLIO_CURATOR_MODEL: "${KLIO_CURATOR_MODEL:-}"
```

The empty default for `KLIO_CURATOR_MODEL` is intentional — the
curator's runtime config resolves the fallback to
`KLIO_EXTRACTION_MODEL` when blank, keeping the compose YAML and
the `~/.klio/.env` both decoupled from the user's specific model
pick.

## CLI surface

### `klio init` — one new prompt

A new "Phase 6 / 6 · Memory curator" block, between the existing
agent-wiring step and the wow-moment. Single yes/no with the
defaults pre-baked into the message; no follow-up questions. The
text reads:

```
Klio's curator reads your observations every hour and turns durable
facts into proper memories — so recall keeps working even when
agents forget to save things explicitly.

  Defaults: every hour · uses your extraction model.
  Run `klio update curator` to change.

  Enable? [Y] › ⏎
  ✓ enabled
```

A `No` answer writes `KLIO_CURATOR_ENABLED=false` and skips the
APScheduler registration in the engine. The user can re-enable any
time via `klio update curator`.

### `klio update` — new top-level subcommand

Re-runs a slice of init without re-pulling images or re-provisioning
the user account. Two phases: pick what to change, then re-run
the matching prompt block. After the prompt, regenerate
`~/.klio/.env` (and `~/.klio/docker-compose.yml` only if the
shape changed), then restart the affected container.

```
$ klio update
What would you like to change?
  1) Provider + model picks
  2) Curator schedule + model
  3) Re-wire AI agents (re-runs adapter detection)
  4) Cancel
  Choice ›
```

Direct subcommands (`klio update curator`, `klio update provider`,
`klio update agents`) skip the menu and jump straight to the
relevant block.

`klio update curator` looks like:

```
Current: every 1 hour, qwen2.5:7b-instruct

  Schedule
    1) every hour      ★ current
    2) every 4 hours
    3) once a day
    4) on-demand only  (disable timer; run with `klio update curator --run-now`)
    5) disable
  Choice [1] ›

  Model
    1) qwen2.5:7b-instruct  ★ current (your extraction model)
    2) Pick a different one
  Choice [1] ›

  ✓ Saved. Restarting engine to apply…
```

`--run-now` exits the picker after saving and triggers an immediate
single-flight curator pass for the current user, useful when a user
has on-demand mode and wants to drain the queue right now without
waiting on a timer.

`klio update agents` re-runs the same adapter-detect / wire flow
init uses — solving the side problem where a user who answered the
wire-tools prompt incorrectly during init is currently stuck
re-running the entire `init` to recover.

## Data flow

For each curator tick, per user:

1. Acquire a per-user `asyncio.Lock` keyed by `user_id`. If held
   (concurrent `--run-now`), no-op silently.
2. Read or create `curator_state` row for `user_id`. Capture
   `last_cursor_at`.
3. `SELECT * FROM entries WHERE user_id = $1 AND kind = 'observation' AND created_at > $2 ORDER BY created_at LIMIT $3`
   with `(user_id, last_cursor_at, KLIO_CURATOR_BATCH_SIZE)`.
4. If zero rows: update `last_run_at`, increment `runs_count`,
   commit, release. Done.
5. Concatenate the batch into a single transcript-shaped string
   (each observation rendered as `[ts] tool=<name> input=<...>`).
   Hand to `FactExtractor.extract(transcript)`. Returns a
   `list[ExtractedEntry]` of zero or more typed items.
6. For each `ExtractedEntry`:
   - Embed via `services/embeddings.py` against the user's default
     space's pinned model.
   - Dedup against existing entries: cosine similarity against the
     user's space, threshold `0.95`. Hit → mark
     `superseded_by=<existing_id>` on the new entry, write
     anyway, do not break the chain. Miss → write fresh.
   - Write through `services/entries.py:write_encrypted` so the
     entry is encrypted, audit-chained, and notification-published
     identically to a user-driven write.
7. Advance `last_cursor_at` to the max `created_at` in the batch.
   Update `last_run_at`, `runs_count`, `last_synthesized`. Clear
   `last_error`.
8. Commit. Release lock.

Steps 4-7 happen inside a single Postgres transaction. If any step
raises, the transaction rolls back, `last_error` is recorded in a
follow-up update outside the failed transaction, and the cursor
does not advance. Next tick re-tries the same window.

## Failure modes

| Failure | Behaviour |
|---|---|
| LLM provider unreachable | `FactExtractor` raises; curator records `last_error`, cursor stays put, next tick retries the same window. No partial writes. |
| LLM returns malformed JSON | `FactExtractor` already falls back to its regex stub for the affected batch; cursor still advances. The user gets degraded-but-non-empty extraction during a flapping LLM. |
| Curator crashes mid-batch | All writes are inside one Postgres transaction. Rollback. Cursor unchanged. |
| Engine container restart | APScheduler picks up at the next interval boundary. No catch-up storm — a long downtime just means the next tick processes a bigger window (capped at `BATCH_SIZE`, so it drains over multiple ticks). |
| User runs `--run-now` while a tick is in progress | Per-user `asyncio.Lock` makes the second invocation a no-op. The user sees `curator: already running, skipping`. |
| Dedup miss writes near-duplicate fact | Cosine threshold 0.95 catches close paraphrases. Misses get caught on the next pass that re-encounters the same observation cluster. |
| User disables curator and re-enables later | `KLIO_CURATOR_ENABLED=false` simply skips the APScheduler registration. On re-enable, the cursor is wherever it was — the curator picks up from there, processing every observation that landed during the disabled window. |

## Cost model

For a typical pairing session: PostToolUse fires ~30 times per
hour. The curator at the default 1-hour cadence reads 30
observations, concatenates them into a transcript of ~3 KB, hands
that to `FactExtractor`, gets back ~2 entries on average.

- **Ollama (local):** ~5 seconds of CPU per pass on a Mac M2.
  Negligible.
- **OpenRouter `qwen2.5:7b-instruct`:** ~3K tokens in, ~500 out,
  about $0.0005 per pass. ≈ $0.36/month at one pass per hour.
- **OpenRouter `gpt-4o-mini`:** about $0.001 per pass. ≈ $0.72/month.

The user can lower this further by setting cadence to "once a day."
The on-demand mode costs nothing until the user runs
`--run-now`.

## Testing

TDD throughout. Every fix or feature lands with the test first.

### Engine

`engine/tests/test_curator.py` — unit tests for:
- Cursor advance: 0 → max(created_at) on success, no change on failure.
- Lock semantics: concurrent run is a no-op, not a 409.
- LLM-down: `last_error` recorded, cursor unchanged.
- Stub backend: deterministic 1-in-1-out for fixture observations.
- Dedup: cosine 0.96 → supersedes, 0.93 → fresh write.
- Batch boundary: BATCH_SIZE+1 observations means the next tick
  picks up the remainder.
- New-user lazy row creation: no `curator_state` row until first
  tick for that user.

`engine/tests/test_curator_integration.py` (skip-if-no-postgres
like the existing `test_api_engine.py`) — seeds 10 fake observations,
runs the curator, asserts ≥1 memory + ≥1 decision, asserts cursor
advanced to the latest observation's `created_at`. Hermetic LLM via
`KLIO_EXTRACTION_MODEL=stub`.

### npm

`npm/tests/curator.test.ts` — init prompt UX (single Y/n, default Y,
re-prompts on non-y/n via the new `askConfirm`), env-write contract
(only `KLIO_CURATOR_ENABLED` set during init, the other vars come
from `klio update curator`).

`npm/tests/update.test.ts` — `klio update` orchestration: the
top-level subcommand routes to the right block, the
`klio update curator` block re-prompts only the curator slice, the
restart path touches only `klio-engine` (not the bridge or
trust-app), `--run-now` triggers a single-flight invocation against
the engine.

### Docs

`docs/curator.md` — short user-facing doc explaining what the
curator is, default cadence + cost, how to change settings, how to
read `klio status`. Linked from the README "How it works" section.

## Compatibility

- **Existing users:** the migration adds `curator_state` lazily; no
  back-fill. On first engine start with the new image, the
  curator's APScheduler job registers if `KLIO_CURATOR_ENABLED` is
  truthy (default true). Existing users get the curator on by
  default after the next `npx @klio-tech/klio@latest init`. They
  can `klio update curator` → `5) disable` to opt out.
- **Pre-0.5.0 npm package + 0.5.0 engine:** the engine env defaults
  in compose make the engine work with no `KLIO_CURATOR_*` vars
  (defaults kick in). No 500.
- **0.5.0 npm + pre-0.5.0 engine:** `klio init` writes the curator
  env block; the old engine ignores unknown env vars. The user
  re-runs init after pulling the new engine image to actually wire
  the scheduler. The README will document the version coupling.

## Out of scope (intentional)

- **Public REST endpoint for triggering curation.** `klio update
  curator --run-now` is the only invocation surface. A REST
  endpoint adds an auth surface area we don't need yet.
- **Cross-user curation.** Per-user is the local-first model.
  Cross-user is a Klio Cloud feature.
- **Per-space curator config.** v1 has one global cadence + model
  per user. Per-space override goes in v1.1 if asked for.
- **Dashboard view.** The trust-app could show a "curator timeline"
  but we're not committing to that until we know the loop is
  useful. `klio status` is the only surface for v1.
- **Curator-of-curators.** A second pass that supersedes the
  curator's own past entries beyond cosine dedup. Premature.
- **Custom extractor prompts per user.** The curator uses
  `FactExtractor`'s default prompt. Customisation is a v2 ask.
- **Re-curating historical observations on enable.** When a user
  enables the curator for the first time, it processes
  observations from `last_cursor_at = '1970-01-01'` (i.e., all
  history) on its first tick. We accept the one-time bigger pass
  rather than building a "skip historical" toggle nobody will use.
