# Changelog

All notable changes to `@klio-tech/klio` and the Klio engine are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/).

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
