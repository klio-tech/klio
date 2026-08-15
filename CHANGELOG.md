# Changelog

All notable changes to `@klio-tech/klio` and the Klio engine are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/).

## [0.9.4] — 2026-08-14

### Added — the local proxy: injection + capture for any agent (cloud, opt-in)

Cloud `klio init` now offers a local proxy on `127.0.0.1:8787`,
**defaulting to no**. On Anthropic's Messages API it appends your team's
Klio memories to the request's `system` field and captures the
conversation as grading evidence — so an agent with no hook surface
still both receives context and contributes evidence. `messages`,
`tools`, `tool_choice` and `tool_reference` blocks are forwarded byte
for byte, and every failure path forwards the original bytes unchanged.
Codex is wired but pass-through for now (it uses `/v1/responses`).

Two kill switches, both **on** by default when a cloud key is present:
`KLIO_PROXY_INJECT=off` and `KLIO_PROXY_CAPTURE=off`.

New: `klio proxy serve|stop|status|ensure`. `/__klio/health` now reports
`mode`, `runtime`, `pid` and a non-reversible fingerprint of the active
config, which is what lets `klio proxy stop` prove a process is ours
before signalling it and lets `klio init` detect a proxy left over from
an earlier run holding rotated credentials. `klio doctor`, `klio down`
and `klio uninit` all handle the Docker-free cloud machine.

Known limitation: a >10 MB request cancelled mid-upload keeps relaying
to the upstream until the body ends (see README).

## [0.9.2] — 2026-05-29

### Added — PostToolUse capture (fuller session capture)

Cloud mode now captures **every tool call** as a lightweight `observation`
(tool name + truncated input/response), restoring parity with the local
bridge so the brain reflects what the agent actually *did*, not just
"remember that…" phrases and end-of-session facts. `klio init` installs a
4th Claude Code hook (`PostToolUse → npx -y @klio-tech/klio hook
post-tool`); observations are tagged `source: hook-tool` and the curator
condenses them into facts over time. Re-run `klio init` to install it.

PreToolUse recall is still intentionally omitted in cloud mode — a remote
recall before every tool action would add noticeable latency, and
SessionStart already injects context.

## [0.9.1] — 2026-05-29

### Changed — per-tool agent attribution

Each wired tool now sends a distinct `X-Vex-Agent` header of the form
`<machine-id>/<tool>` (e.g. `klio-host/claude-code`, `klio-host/cursor`)
instead of all tools sharing one machine-level id. This lets the hosted
brain — and the dashboard — attribute every captured/recalled memory to
the exact tool that produced it (Claude Code vs Cursor vs Codex …),
rather than just the machine. The passive `klio hook` client (Claude
Code only) reports as `<machine-id>/claude-code`.

Memories remain org-scoped and shared across tools; this only sharpens
provenance. Re-run `klio init` (cloud mode) to adopt the per-tool ids —
memories written under the old single id still display, attributed to
the machine.

## [0.9.0] — 2026-05-29

### Added — passive memory capture in Klio Cloud (Path B)

Cloud mode could already *recall* and *remember* through the 7 MCP
tools, but nothing was captured **passively** — so a cloud user's brain
only grew when an agent explicitly wrote to it. 0.9.0 brings the
local-first capture loop to the hosted brain, with no Docker and no
local engine:

  - **`klio hook <event>` client** — a thin, soft-fail passive-capture
    forwarder Claude Code invokes on lifecycle events. It reads the
    event JSON on stdin and POSTs to the hosted brain's capture API:
      - **SessionStart** → fetch recent/relevant memories and inject
        them as `additionalContext` (the same "## Klio context for this
        session" block the local bridge emits).
      - **UserPromptSubmit** → capture explicit "remember that …" /
        "note that …" trigger phrases as durable memories (plain prompts
        are mined from the transcript instead, keeping noise down).
      - **Stop** → forward the session transcript so the brain distils
        it into facts + a summary.
    The command is **soft-fail by contract**: a missing config, a
    malformed payload, or a network error all exit 0 silently — a hook
    can never block or disrupt a Claude Code session.
  - **Cloud capture hooks installed on wiring** — `klio init` (cloud
    mode) now installs three Claude Code hooks (SessionStart /
    UserPromptSubmit / Stop) pointing at `npx -y @klio-tech/klio hook
    …`, replacing the previous "strip all hooks" behaviour. Stale local
    `docker exec … klio hook …` entries are still stripped first, so a
    re-run converges cleanly. Per-call events (Pre/PostToolUse) are
    intentionally **not** wired in cloud mode to avoid a network
    round-trip and embedding cost on every tool call.
  - **Cloud credentials persisted** to `~/.klio/config.json` (0600) so
    the hook client can authenticate on every event without an MCP
    handshake.

**Engine / MCP server (Vex-hosted):**

  - **REST capture API** (`POST /capture/event`, `/capture/transcript`,
    `/capture/recall`) — the passive counterpart to the MCP tools,
    authenticated by the same `X-Vex-Key` (+ `X-Vex-Agent`) bridge and
    scoped to the caller's org. Reuses the existing brain write/recall
    primitives and `extract_facts` / `generate_summary`; best-effort
    per-project tagging from the working repo's git remote.
  - **In-process curator scheduler** — the org-scoped brain curator now
    runs on a background loop in the service lifespan (configurable via
    `CURATOR_ENABLED` / `CURATOR_INTERVAL_SECONDS`), so synthesised
    summaries and facts accrue without an external cron.

### Added — cloud wiring for Claude Desktop, OpenCode, and OpenClaw

Cloud-mode `klio init` now also wires three more agents to the hosted
brain (previously Claude Code, Cursor, and Codex only):

  - **Claude Desktop** and **OpenClaw** (stdio-only configs) get an
    `mcp-remote` bridge that forwards both auth headers upstream.
  - **OpenCode** gets a native `{type:"remote"}` MCP entry.

Each writer backs up the existing config and preserves peer servers.

## [0.8.0] — 2026-05-29

### Added — Klio Cloud onboarding (`klio init` cloud-default mode)

`klio init` now opens with a **Cloud (default) / Local** choice. Cloud
mode connects your agents to the hosted Klio brain at
`https://mcp.klio.tech` in seconds — **no Docker, no local engine, no
model setup**:

  - **Mode prompt** at the top of `init` (default Cloud on Enter), plus
    `--cloud` / `--local` flags to skip the prompt for non-interactive
    runs.
  - **Cloud flow:** paste your API key → it's verified against
    `GET https://mcp.klio.tech/verify` (clear messages for an invalid
    key or one missing the `memory` scope) → your agents are wired and
    you're done. Phases 1–3 + 5 of the local flow (Docker preflight,
    model provider, stack bring-up, curator) are skipped — the hosted
    brain already provides embeddings, storage, and curation.
  - **Agent wiring** writes a remote **Streamable-HTTP** MCP entry
    (`https://mcp.klio.tech/mcp` with `X-Vex-Key` + a stable
    `X-Vex-Agent` header) to Claude Code, Cursor, and Codex. Existing
    config + peer MCP servers are preserved; every file is backed up
    before patching. The API key is masked (last-4) in all output.

**Engine / MCP server (Vex-hosted):** the hosted brain exposes the 7
Klio tools (`recall`, `remember`, `observe`, `plan`, `decide`, `note`,
`space`) over MCP, gated by a dedicated `memory` API-key scope, plus a
lightweight `GET /verify` endpoint used by the cloud onboarding flow.

The local-first flow is unchanged — selecting **Local** runs the exact
same six-phase Docker onboarding as before.

## [0.7.1] — 2026-05-28

### Added — project surfaces in the trust-app dashboard

0.7.0 made `recall` project-aware for agents but left the human-facing
dashboard blind to it: `/memories` could only filter by space and
kind, and the API didn't even return an entry's `project_id`. 0.7.1
closes that gap.

**Engine:**

  - `EntryResponse` now carries `project_id` (populated on every entry
    read + write path).
  - New `GET /v1/projects` — lists the caller's projects with
    `display_name`, `git_remote`, `dedicated_space_id`, timestamps,
    and a per-project `entry_count`. Ordered by `last_seen_at DESC`
    with an `id` tiebreaker for deterministic paging. Tenant-scoped.
  - `GET /v1/spaces/{id}/entries` accepts an optional `project_id`
    filter. When set, it returns that project's entries plus
    NULL-tagged (uncategorized) entries — the same B2 NULL-surfacing
    semantics recall uses, so a project view still shows your
    pre-0.7.0 global pool.

**Dashboard (`/memories`):**

  - A project dropdown alongside the space tabs ("All projects" +
    each `display_name (entry_count)`). Hidden entirely for users
    with no projects yet.
  - A subtle project badge on each memory row; NULL-tagged entries
    read as `· uncategorized`.
  - Space, kind, and project filters all compose in the URL.
  - The project filter is **best-effort**: if the engine is older
    than 0.7.1 and 404s on `GET /v1/projects`, the dashboard hides
    the filter and still renders entries rather than failing the
    whole page — version skew between the trust-app image and the
    engine is a graceful degrade, not a 500.

### Deferred to a later release

  - Session-level drill-down (group a project's entries by the
    conversation that produced them — `sessions.cwd` from 0.7.0
    makes this possible). The dashboard differentiates by project
    now; by session later.

[0.7.1]: https://github.com/klio-tech/klio/releases/tag/v0.7.1

## [0.7.0] — 2026-05-28

### Added — per-project memory scoping

Before 0.7.0, every memory captured by Klio landed in the user's
single active space. Claude's `recall` returned the top-k
semantically nearest entries with no project context — so when the
user worked in Project A and asked a question, half the recalled
entries came from Project B's unrelated work. The user's exact
words: "Claude wants to be pushed with data from Klio, but the data
is from a different project, so Claude rejects it." Wasted tokens
on the good path; correctness risk on the bad one.

0.7.0 adds an invisible **projects** layer underneath spaces. Every
write is auto-tagged with a `project_id` derived from the session's
git context. Every recall defaults to the active project. The user
never has to think about it. Spaces stay as the user-controlled
coarse grouping (Personal / Work / Side); projects are the
auto-detected fine-grained layer.

#### Auto-detection (bridge)

`bridge/internal/project.Resolve` derives a project identity from
each hook fire in priority order:

  1. `git remote get-url origin` — the strongest stable identity
     across machines and clones.
  2. `git rev-parse --show-toplevel` — same repo, no remote yet.
  3. The session's absolute `cwd` — non-git workspaces still get
     their own bucket.

The resolved identity is sent to the engine via a new
`POST /v1/projects/ensure` endpoint that returns a stable `project_id`
(get-or-create). A bounded LRU cache (`bridge/internal/project.Cache`)
amortizes git/syscall cost across hook fires; cache misses concurrent
on the same key collapse to a single resolve via a singleflight
group.

#### Recall scoping (engine + MCP)

`recall` defaults to the active project's entries. The MCP tool
schema gains a `project` parameter accepting:

  - absent / null → active project (the safe default)
  - `"any"` → cross-project, the explicit escape hatch
  - a git remote URL (e.g. `git@github.com:klio-tech/klio.git`) →
    a specific other project
  - a UUID → for direct API consumers

NULL-tagged entries (everything written before 0.7.0) always
surface in every project's recall. This is deliberate: pre-0.7.0
sessions weren't isolated, so users have a "global pool" of legacy
memory that they would lose if NULLs were filtered out. The safe
default preserves that value forever; there is no backfill (the
hook payloads pre-0.7.0 didn't capture `cwd` consistently, so we
can't reconstruct project identity for old entries).

#### Promote-to-space escape valve

For the rare project that needs **harder** isolation than tagging
(different embedding model, isolated KMS key, atomic forget),
operators can elevate it to a dedicated space:

```bash
klio project promote git@github.com:acme/secret-repo.git \
  --embedding text-embedding-3-large
```

Or attach to an existing space:

```bash
klio project promote <project-uuid> --space <space-uuid>
```

Behind the CLI: `POST /v1/projects/{id}/promote` creates (or
attaches) a `dedicated_space_id`, returning 409 on re-promote so
the operator can't accidentally double-promote. The promote path
audits via the existing audit-event stream; the ensure path does
not (every hook fire would generate one — see deferred items).

### Migration

Two new alembic migrations:

  - `0007_session_cwd.py` — adds `sessions.cwd TEXT NULL` so the
    bridge can persist working-directory context.
  - `0008_projects.py` — adds the `projects` table and
    `entries.project_id UUID NULL` FK.

The `projects` table uses two partial unique indexes (not a CHECK)
to enforce uniqueness semantics:

  - `(user_id, git_remote)` when `git_remote IS NOT NULL`
  - `(user_id, repo_root_path)` when `git_remote IS NULL AND
    repo_root_path IS NOT NULL`

No backfill of historical entries — they stay `project_id = NULL`
and surface globally as described above.

### Schema-facing surfaces (downstream consumers)

  - **Engine** — new endpoints `POST /v1/projects/ensure` and
    `POST /v1/projects/{id}/promote`. Recall request body's
    `project` field accepts UUID | git remote | `"any"` | absent.
    Write endpoints (`/v1/entries`, `/v1/ingest`) accept an
    optional `project_id` in the body.
  - **Bridge** — new cloud-client methods `EnsureProject` and
    `PromoteProject`. New `RecallRequest.Project` (`string`,
    `omitempty`). Hook payloads' existing `cwd` is now consumed
    for project detection.
  - **MCP** — recall tool's input schema gains an LLM-actionable
    `project` description so Claude knows when to widen via
    `"any"` vs. a specific remote.

### Known limitations / deferred to 0.7.x

  - **Bridge cache lifetime.** `project.Cache` lives inside each
    per-hook subprocess (Claude Code spawns the bridge fresh per
    fire), so it doesn't yet amortize across hook fires within a
    session. Moving it daemon-side via the existing socket saves
    ~30-50ms × 200+ fires per session. Tracked for 0.7.x.
  - **Cross-tenant validation on `entries.project_id` writes.** The
    write path currently accepts a caller-supplied `project_id`
    without verifying it belongs to the caller. The promote path
    does validate. Write-side tightening is queued.
  - **Audit events on `/v1/projects/ensure`.** Every hook fire
    eventually resolves to a `projects` row. We do **not** audit
    the ensure path today (it would generate one audit event per
    hook fire — too noisy). The promote path **does** audit. The
    right granularity is still open.
  - **Test-DB residue.** Tests occasionally leave rows in
    `public.users` of the test database. Worked around manually
    per-task; structural fix queued.

### Tests

76 new test functions across engine (Python/pytest) and bridge
(Go) covering: schema migrations, ORM models, services, API
endpoints, project detection (git → fs precedence), LRU cache (LRU
semantics + race-safe concurrency invariant), cloud-client wire
formats, hook handlers (fail-open guarantee on detection failure),
MCP recall-tool schema. Full sweep green at commit time.

### Production-readiness

The feature has been verified end-to-end via the smoke runbook at
[`docs/runbooks/2026-05-28-project-scoping-smoke.md`](./docs/runbooks/2026-05-28-project-scoping-smoke.md)
(two-repo smoke covering: ensure idempotency, write tagging,
default-scoped recall, `"any"` cross-project widening, remote-URL
targeting, promote-to-space, legacy NULL survivability).

[0.7.0]: https://github.com/klio-tech/klio/releases/tag/v0.7.0

## [0.6.1] — unreleased

### Fixed — auto-update silently failed on every host

0.6.0 shipped the bridge ticker that detected newer versions and
attempted to apply them via `docker compose pull && up -d` from
inside the bridge container. The bridge container has no `docker`
CLI, so every apply failed with
`exec: "docker": executable file not found in $PATH`, and
`~/.klio/update-state.json` carried that error from the moment a
newer release shipped.

The fix is architectural, not a `RUN apt-get install docker` patch
(which would have forced docker-in-docker or a privileged
docker.sock mount — both unacceptable security postures):

- The bridge ticker now writes a sentinel at
  `~/.klio/update-pending.json` describing the target version,
  rather than shelling out itself.
- A new long-running host command, `klio update --watch`, polls
  the sentinel every 30s and runs `docker compose pull && up -d
  --no-deps engine bridge trust-app` on the host's docker daemon.
- The watcher updates `~/.klio/update-state.json`'s
  `last_applied_version` / `last_applied_at` after a successful
  apply, surfaces transient docker-hub rate-limits via
  `last_apply_error` while keeping the sentinel in place for
  retry, and rejects bogus target versions (non-semver) with the
  sentinel removed so the bridge gets to write a fresh one.

To enable apply-mode auto-update on a host, run the watcher under
launchd / systemd or in a long-lived terminal:

```bash
npx @klio-tech/klio update --watch
```

Without the watcher running, the bridge still surfaces
`last_known_available_version` in the dashboard (effectively
`notify` mode), and `klio update --to-latest` continues to work
as a manual apply path.

### Added — sentinel module + watcher tests

- `bridge/internal/updater/pending.go` — atomic Read/Write/Remove
  helpers for `update-pending.json`. Mirrors `state.go`'s
  atomicity contract so a concurrent reader never sees a partial
  file.
- `npm/src/commands/updateWatch.ts` — `runWatchTick` (one-shot,
  test-friendly) and `runWatch` (poll loop). Test seams expose
  `composeApply`, `intervalSecs`, and `maxTicks` so the suite
  drives the watcher without touching the user's docker daemon.

### Fixed — bridge reported `0.0.0-dev` in production

`klio status` and the auto-update ticker both reported
`current_version=0.0.0-dev` in shipped images because the version
was only resolved from `KLIO_BRIDGE_VERSION` env, which the compose
template didn't always thread through. Compounding the issue,
`internal/version/version.go` had a stale hardcoded `"0.0.1"` from
an early prototype that `klio version` and `klio status` were
reporting — independent of whatever version the npm CLI thought
it had pulled.

The fix unifies both source-of-truth points behind a new file-first
resolver in `internal/version`:

1. `/etc/klio-version` (image-baked at build time via
   `--build-arg KLIO_VERSION=...`).
2. `KLIO_BRIDGE_VERSION` env (the dev path: `go run ./cmd/klio` on
   a workstation where the file doesn't exist).
3. The literal string `0.0.0-dev` (panic button).

Why the file beats the env: a misconfigured compose template that
forgot to thread the env can't make the bridge lie about its own
version — the file ships in the same image layer as the binary, so
the version reported is guaranteed to match what's running.

The Dockerfile now accepts `ARG KLIO_VERSION=0.0.0-dev` and writes
it to `/etc/klio-version`. The release-images workflow passes
`--build-arg KLIO_VERSION=<npm/package.json version>` for the
bridge image so every published bridge image carries the right
version regardless of compose env.

`internal/daemon/updater_ticker.go::readCurrentVersion` is now a
thin wrapper over `version.Get()` so the auto-update ticker, the
`klio version` command, and the `klio status` JSON output all
report the same value.

## [0.6.0] — 2026-05-07

### Added — auto-update + email claim

Two interlocking features so v0.5.x bug-of-the-week incidents don't
strand users on broken images, and so security/breaking-change
notifications reach the people running Klio.

#### Auto-update (default ON)

The bridge daemon gains a second ticker (alongside the curator) that
runs every `KLIO_UPDATE_CHECK_INTERVAL_SECS` (default 21600 = 6h):

  1. `GET https://registry.npmjs.org/@klio-tech/klio/latest`
  2. If a newer version is found, write
     `~/.klio/update-state.json` with the latest-known + last-check
     timestamp.
  3. If `KLIO_AUTO_UPDATE=apply` (the default), shell out to
     `docker compose pull && up -d --no-deps engine bridge
     trust-app`. The bridge container that's running this code is
     itself one of the recreated containers — APScheduler-equivalent
     state is persisted to disk before the recreate so the new
     bridge starts on the new image and continues normally.

Three new env vars on `~/.klio/.env`:

  - `KLIO_AUTO_UPDATE=apply` (or `notify`, `off`)
  - `KLIO_UPDATE_CHECK_INTERVAL_SECS=21600`
  - `KLIO_UPDATE_STATE_PATH=/host/.klio/update-state.json`

`klio configure auto-update {apply, notify, off}` toggles modes
without re-running init. `klio update --check` prints the current
vs latest version. `klio update --to-latest` and `klio update
--to-version <X>` are manual override paths.

#### Email-claim during onboarding

A new sub-prompt at the end of `klio init` Phase 6 (the
wow-moment) asks the user for an email and triggers the engine's
existing magic-link claim flow. The user can `⏎` to skip; init
completes either way. Garbage email re-prompts up to 3 times
then treats as skip.

A new top banner in the trust-app dashboard reminds unclaimed
users to claim. Banner data comes from a tiny new engine endpoint
`GET /v1/system/banners` which emits a `claim_email` banner when
`users.claimed_at IS NULL`. The dashboard's inline form posts
directly to `/v1/auth/login-link`.

`klio configure email <addr>` is a post-install alias that re-uses
the same magic-link path — useful if a user skipped during init
and wants to claim later.

### Added — compose volume mounts

`~/.klio` is now mounted into both the bridge (rw, for the updater
to write state) and the trust-app (ro, for the dashboard to surface
status). Existing `klio-bridge-data:/data` and
`${HOME}/.claude:/host/.claude:ro` mounts are unchanged.

### Changed

- `klio init` is now a 6-phase flow with an additional Phase 6
  email sub-prompt (the wow-moment now sits at the end of Phase 6
  rather than being its entirety).
- New `npm/src/email.ts` shared helper extracted from D1 / D2 —
  both `klio configure email` and `klio init`'s Phase 6 sub-prompt
  use the same `looksLikeEmail` validator and `sendLoginLink` POST
  helper.

### Known follow-ups (not in 0.6.0)

- **Email-on-major-version notifications.** The bridge's auto-update
  path (C4) successfully applies a new version and persists state,
  but the planned C5 work — sending a one-line email summary to
  email-claimed users on major-version landings — is deferred to
  0.6.1. Wiring point is in place
  (`runUpdateOnce` in `bridge/internal/daemon/updater_ticker.go`);
  v0.6.1 drops in the cloud-client call.
- **GitHub OAuth as an alternate claim path.** Engine has no OAuth
  flow today. Planned for v0.7 if user-pull is significant.
- **Auto-rollback on healthcheck failure.** Watchtower-style
  failover. Today, if a new image fails its healthcheck, compose
  restarts 3 times then exits — operator must manually
  `klio update --to-version <previous>` to roll back.

[0.6.0]: https://github.com/klio-tech/klio/releases/tag/v0.6.0

## [0.5.4] — 2026-05-07

### Added — full request + response capture in observations

`bridge/internal/hooks/handlers.go:PostToolUse` now records both
`ToolInput` and `ToolResponse` from every PostToolUse hook event.
Pre-0.5.4 it only captured `ToolInput`, *and only if under 400 bytes*
— anything bigger (multi-line bash stdin, large edits, bulk reads)
silently became "Used tool Edit" with zero context. The curator's
`FactExtractor` had no signal to extract from, so synthesised
memories were thin and the tool had little to chew on.

The new format:

```
Used tool {ToolName}
input: {ToolInput, truncated to 2000 chars}
response: {ToolResponse, truncated to 2000 chars}
```

Truncation appends `... (truncated, original N bytes)` so the
extractor can see when it got a partial view. Total observation
content capped at ~4 KB to keep embedding contexts reasonable.

Three new tests in `bridge/internal/hooks/handlers_test.go` pin the
contract: input + response both captured, large fields truncated
with the suffix marker, missing-response payloads handled cleanly.

### Fixed — test isolation guardrail (the 0.5.3 incident)

A test subagent's setup ran `TRUNCATE public.users CASCADE` against
the user's PRODUCTION Postgres while trying to clean up "stale test
data," wiping ~29 real users + 1304 entries. The conftest's safety
model failed: it expected an isolated test DB at
`127.0.0.1:5433` but didn't fail-fast when the actually-targeted DB
looked production-shaped.

`engine/tests/conftest.py` now exports `_refuse_if_production_db`,
which queries the `users` table (resolved via `search_path` so the
guardrail also catches misconfigured per-test schemas) and aborts
the run with a clear refusal if there are more than 5 rows. The
threshold is generous for stale-fixture leakage but catches anything
an order of magnitude beyond a clean test DB. The 0.5.3-incident DB
had ~29 users — would have tripped the guardrail at 6.

`engine/tests/test_conftest_guardrail.py` is the self-defending
test for the guardrail itself. If anyone in the future loosens or
removes the check, this file fails — making the bug self-defending.

### Fixed — pytest unqualified-resolution

The guardrail intentionally uses unqualified `to_regclass('users')`
+ `SELECT count(*) FROM users` rather than `public.users`, so it
resolves via the connection's `search_path`. Production callers
default to `search_path=public` (catches real prod data); test
callers run with `search_path=<isolated_schema>` (the per-test
schema's empty users table). A qualified `public.users` lookup
would short-circuit search_path resolution and break the
guardrail's own self-tests.

### Known follow-ups (not in 0.5.4)

- `klio curator run-now` Go subcommand on the bridge — still
  outstanding from 0.5.0. Without it, the npm CLI's `--run-now`
  flag prints a graceful "bridge does not yet support this
  subcommand" message rather than triggering an immediate pass.
- A `engine/CLAUDE.md` "database safety rules" section explicitly
  warning subagents not to `docker exec klio-postgres psql ...`
  for destructive SQL. The guardrail prevents the worst case at
  runtime; the docs would prevent it at the brain-of-future-agent
  level.

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
