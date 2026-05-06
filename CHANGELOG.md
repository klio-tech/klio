# Changelog

All notable changes to `@klio-tech/klio` and the Klio engine are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/).

## [0.5.3] — 2026-05-07

### Fixed

- **`klio init` dedup tiebreaker now picks the user with the most
  entries, not the oldest by `created_at`.** 0.5.2's dedup landed
  the right CONCEPT (re-find by install_id instead of always
  inserting) but the wrong tiebreaker for the recovery path: the
  oldest user with a given install_id is often a stale broken
  account from an early init run (e.g., one whose Default Space
  got pinned to `openrouter/openai/text-embedding-3-small` from
  compose.ts's hardcoded fallback before the picker was properly
  threaded through). Picking that user re-credentialed the bridge
  against an unreachable embedding pin and every subsequent recall
  / write 500'd.
- 0.5.3 picks the user with the highest entry count, falling back
  to oldest `created_at` for the trivial zero-entry tie. This
  follows the data: "the user with the most accumulated history is
  who this install_id 'really' belongs to."
- For users on 0.5.2 who hit the openrouter-pinned-stale-space
  500 loop on the bridge: just upgrade and re-run `klio init`.
  No SQL surgery needed.

## [0.5.2] — 2026-05-07

### Fixed

- **`klio init` is now actually idempotent.** Pre-0.5.2, the engine's
  `provision_user` always inserted a fresh `User()` row even when
  called with an `install_id` it had seen before — every re-run of
  `klio init` silently created a brand-new anonymous account, and
  the user's prior memories became invisible (still in Postgres,
  just under a user_id no longer wired to the bridge or trust-app).
  0.5.2 makes `provision_user` look up the agent by `install_id`
  first; if found, it mints a fresh access+refresh token for the
  existing user and returns the same `(user_id, agent_id,
  default_space_id)` tuple instead of creating a duplicate.
- Users on 0.5.1 and earlier who already accumulated duplicate
  users will recover automatically: the next `klio init` after
  upgrading picks the OLDEST user with their install_id (the one
  with the longest write history, hence the most memories) and
  rebinds the bridge to them.
- Audit log records whether a `user.provision` call created a new
  user or re-found an existing one via `metadata.created` (true /
  false), so operators can tell the two paths apart from the chain.

### Known follow-ups (not in 0.5.2)

- A `UNIQUE(install_id)` constraint on `agents` — requires a
  back-fill migration to merge any pre-existing duplicates first.
- A cleanup script that merges duplicate users by install_id (for
  operators who care; the auto-recovery above means most users
  won't notice the duplicates exist).

## [0.5.1] — 2026-05-07

### Fixed

- **`klio-engine` container 0.5.0 was missing `apscheduler` at runtime.**
  The engine Dockerfile maintains its own hand-typed pip-install list
  (parallel to the runtime deps in `engine/pyproject.toml`); when
  `apscheduler` was added to `pyproject.toml` for the curator, the
  Dockerfile was not updated to match. The published `:0.5.0` image
  crashed on startup with
  `ModuleNotFoundError: No module named 'apscheduler'` the moment
  `klio_engine.api.main` was imported. **0.5.1 republishes the engine
  image with `apscheduler>=3.10,<4` in the runtime layer.**
- Cleaned up a long-standing piece of dead weight: the Dockerfile's
  pip list still installed `litellm>=1.50` even though the engine
  dropped LiteLLM in 0.3.0 (the engine routes via direct httpx now).
  Removing it shaves ~30 MB off the runtime image and removes an
  attack surface that was never exercised.
- Added a load-bearing comment in the Dockerfile explaining that the
  pip list is hand-maintained in parallel to `pyproject.toml` and
  must be kept in sync. A future migration to `pip install .` (driven
  by the pyproject's `[build-system]`) would eliminate the drift
  surface entirely; tracked as a follow-up.

### Why this is a separate release rather than a re-tag of 0.5.0

The compose template uses `pull_policy: missing`, so a user who
already pulled the broken `:0.5.0` image keeps running it on every
subsequent `docker compose up` even after the registry has the fix.
Bumping to `:0.5.1` is the only way to give every user a clean image
without telling each one to manually `docker image rm` the broken
copy.

## [0.5.0] — 2026-05-06

### Added — Klio Curator

A background async job inside `klio-engine` now reads recent
`kind=observation` entries on a schedule, hands them to the existing
`FactExtractor`, and writes the synthesised `memory` / `decision` /
`plan` / `note` entries back. This closes the gap where Claude's
mechanical PostToolUse log piled up but no semantic memory accumulated
because no one had explicitly called `remember` / `note` / `decide`.

- **Single new yes/no prompt during `klio init`** — the existing
  five-phase flow grows a sixth phase. Defaults are baked in (enabled,
  hourly cadence, inherits the user's extraction model). One keypress
  for the median user.
- **`klio update` top-level subcommand** — change settings without
  re-running init. Direct subcommands: `klio update curator`,
  `klio update agents`, `klio update provider`. `klio update` with no
  argument shows a four-option picker. Each block re-prompts only its
  own slice and restarts only the engine container.
- **Engine endpoint `POST /v1/curator/run-now`** — authenticated,
  triggers an immediate single-flight pass for the current user.
- **`klio update curator --run-now`** — npm CLI flag that asks the
  bridge to invoke the run-now endpoint right after a save.
  Gracefully degrades when the bridge doesn't yet ship the matching
  subcommand (see Known Limitations below).
- **Two new env vars on the engine container**:
  `KLIO_CURATOR_ENABLED` (default `true`) and
  `KLIO_CURATOR_INTERVAL_SECS` (default `3600`; `0` is the on-demand
  sentinel — see Cadences below).
  `KLIO_CURATOR_MODEL` (optional override; falls back to the user's
  extraction model when unset).
- **Cadences (npm `klio update curator`)**:
  - `hourly` / `every-4h` / `daily` — clock-driven APScheduler ticks
    at 3600 / 14400 / 86400 second intervals.
  - `on-demand` — no scheduled ticks; `--run-now` (and the
    underlying `POST /v1/curator/run-now` endpoint) is the only
    invocation surface. Engine maps to `KLIO_CURATOR_INTERVAL_SECS=0`,
    which the lifespan reads as the "skip job registration" sentinel.
  - `disabled` — `KLIO_CURATOR_ENABLED=false`. The lifespan never
    spins up the scheduler; the run-now endpoint returns 503.
- **One new alembic migration** (`0006_curator_state`) — adds the
  per-user cursor table. No data migration; existing users get a
  fresh `last_cursor_at = '1970-01-01'` cursor on their first tick,
  so every observation they own is eligible for synthesis.
- **Per-user APScheduler job** — registered at engine startup AND on
  every successful `provision_user` call, so brand-new users start
  getting synthesis on their next tick boundary without waiting for
  an engine restart.
- **Per-user single-flight lock** — a tick that's already running for
  user `U` is a no-op when re-fired (verified by a 50-coroutine
  asyncio stress test in `test_curator_pg.py`).

### Added — `klio update agents` recovery path

A user who answered the wire-tools prompt incorrectly during init
(typed memory text instead of "y") can now recover with one command
instead of re-running the full `klio init`. Same detection + wiring
flow as Phase 4, no config drift.

### Changed

- `klio init` is now a 6-phase flow (was 5). The new Phase 5 is the
  Memory curator prompt; the wow-moment moves to Phase 6.
- `wireDetectedAgents` extracted from `init.ts` into a shared module
  so `klio update agents` can re-use it without duplication.
- `apscheduler` pinned to `<4` in the engine — 4.x changed the
  lifespan API in a way that breaks the FastAPI integration; we'll
  migrate when the dust settles upstream.
- Curator settings carry non-negative validation
  (`KLIO_CURATOR_INTERVAL_SECS >= 0` — `0` is the on-demand sentinel,
  negative values are rejected; `KLIO_CURATOR_BATCH_SIZE > 0`), so a
  misconfigured value fails fast at startup with a clear Pydantic
  error rather than producing a silently-broken scheduler.

### Fixed

- `Curator._render_transcript` now reads decrypted observation content
  via the new `DecryptingObservationReader` adaptor — without it, every
  scheduled tick would have crashed reading the `Entry` model's
  encrypted `content_ciphertext` column.
- The `curator_state` table carries non-negative CHECK constraints on
  `runs_count` and `last_synthesized_count`, so a bug that decrements
  past zero surfaces as an integrity error instead of corrupting
  counters.
- `last_cursor_at` is indexed for the recurring "rows newer than
  cursor" lookup that runs every tick.

### Known limitations

- `klio update curator --run-now` requires a Go-side
  `klio curator run-now` subcommand on the bridge, which lands in a
  follow-up release. The npm side handles the absence gracefully:
  the user sees a "Run-now skipped — bridge does not yet support
  this subcommand" message rather than an error.
- The curator processes one user per tick; a per-user APScheduler
  job is registered at engine startup AND on every successful
  provisioning. Mid-uptime user creates that DON'T go through
  `provision_user` (none today, but a pgloader sync to a fresh
  schema would qualify) wouldn't get registered until the engine
  restarts.

[0.5.0]: https://github.com/klio-tech/klio/releases/tag/v0.5.0
