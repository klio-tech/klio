# Email claim + auto-update — design

**Date:** 2026-05-07
**Status:** Approved, ready for implementation plan
**Target release:** `0.6.0`

## Why this exists

Two adjacent gaps after the v0.5.x curator series:

1. **No way to reach users.** `klio init` provisions an anonymous account
   (`users.email_hash = NULL`, `users.claimed_at = NULL`). When a
   security release ships — like 0.5.1's apscheduler dep fix that turned
   every 0.5.0 install into a crashed engine — there's no contact path.
   The user needs an email to reach them.
2. **Locally-running stacks don't update themselves.** Compose pins
   images by version (`klio-engine:0.5.4`) and uses
   `pull_policy: missing`, so a once-installed stack never sees newer
   images unless the user re-runs `npx @klio-tech/klio@latest init`.
   Tonight alone shipped 0.5.0 → 0.5.4; a user installed at 0.5.0 has a
   crashed engine right now.

The two are intentionally bundled. Auto-update wants to email users
when major versions ship; the email-claim flow makes that possible.

Companion plan: `docs/plans/2026-05-07-email-claim-and-auto-update-implementation-plan.md`.

## Decisions, settled in brainstorming

1. **Email gating is soft, not hard.** Anonymous installs proceed.
   Phase 6 (the wow-moment) prompts for an email; the user can `⏎`
   to skip and try Klio first. The dashboard + `klio status` reminds
   unclaimed accounts every session until they claim. (Q1 → Option B.)
2. **Auto-update is on by default.** Default is `apply`: bridge
   ticker silently pulls + recreates engine + bridge + trust-app
   on a 6-hour cadence. The user can opt down to `notify` (banner
   only, manual apply) or `off` via `klio configure auto-update <mode>`.
   No major-version brake — trust the release discipline; if a
   release needs operator attention, ship a tombstone that refuses
   to auto-bump. (Q2 → Option D, default `apply`.)
3. **No new database tables.** The `system_notifications` shape was
   overkill for v1. Re-use existing `users.claimed_at` for the email
   banner; use a single JSON file at `~/.klio/update-state.json`
   for the bridge's update-applied bookkeeping. One new tiny REST
   endpoint (`GET /v1/system/banners`) for the dashboard banner.

GitHub OAuth, Klio Cloud login, auto-rollback on healthcheck failure,
and telemetry beyond version-check are all explicitly out of scope
for v0.6.0.

## Architecture

```
                                       ┌──────────────────────┐
                                       │       npm registry   │
                                       │  /@klio-tech/klio    │
                                       └──────────┬───────────┘
                                                  │ GET ?latest, every 6h
                                                  ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │                          klio-bridge (Go)                            │
   │                                                                      │
   │   • existing curator ticker                                          │
   │   • NEW: update-check ticker (6h)                                    │
   │       → compare latest npm version vs ~/.klio/update-state.json      │
   │       → if newer (any axis): docker-cli pull + recreate              │
   │       → write applied state to ~/.klio/update-state.json             │
   │   • NEW: notify-claimed-users ticker (24h)                           │
   │       → for users with claimed_at + email_hash, send major-version   │
   │         email summary (engine SMTP path, already exists for          │
   │         magic-link)                                                  │
   └──────────────────────────────────────────────────────────────────────┘

   ┌──────────────────────────────────────────────────────────────────────┐
   │                          klio-engine                                 │
   │                                                                      │
   │   • existing magic-link claim flow (POST /v1/users/login/start)      │
   │   • NEW: GET /v1/system/banners                                      │
   │       returns [{kind: "claim_email"}] when user.claimed_at IS NULL   │
   │       (other banner kinds are future-proofing — empty for v1)        │
   └──────────────────────────────────────────────────────────────────────┘

   ┌──────────────────────────────────────────────────────────────────────┐
   │                        klio-trust-app (Next.js)                      │
   │                                                                      │
   │   • NEW: top banner reads /v1/system/banners                         │
   │   • NEW: "Claim your account" inline form posts to                   │
   │     POST /v1/users/login/start, shows "Magic link sent"              │
   └──────────────────────────────────────────────────────────────────────┘
```

## Data flow

### Email claim during init

1. `klio init` Phase 6 prompts for email (default `[skip]`).
2. If skipped: `provision_user(..., email=None)` runs as today;
   `users.email_hash = NULL`, `users.claimed_at = NULL`. Init succeeds.
3. If email entered: `provision_user(..., email=<addr>)` populates
   `users.email_hash = sha256(email)`. After provision, the npm CLI
   calls `POST /v1/users/login/start` with the email; engine sends a
   magic-link via the existing notify backend (console-log in dev,
   SMTP in prod). Init proceeds without waiting on link verification.
4. The user clicks the magic link any time later → existing
   `verify-magic-link` flow sets `users.claimed_at = now()`.

### Update check + apply (default `apply` mode)

1. Bridge ticker fires every `KLIO_UPDATE_CHECK_INTERVAL_SECS`
   (default 21600 = 6h).
2. Reads `~/.klio/update-state.json` (creates with current version
   on first tick).
3. `GET https://registry.npmjs.org/@klio-tech/klio/latest` →
   `{"version": "0.6.1"}`. 10s timeout; failures log + exit cleanly.
4. If `latest > current`:
   - `docker compose -f ~/.klio/docker-compose.yml pull` (pulls
     all four image tags — engine, bridge, trust-app, plus the
     pgvector + redis pins which never bump but are safe to re-pull).
   - `docker compose -f ... up -d --no-deps engine bridge trust-app`
     (recreates the three klio containers; postgres + redis stay).
   - Write `update-state.json`:
     `{current_version, last_check_at, last_applied_version, last_applied_at, last_error: null}`.
5. The bridge that just executed the recreate is itself one of the
   recreated containers. APScheduler-equivalent gracefully handles
   this — the ticker writes its state to disk before the recreate
   command, the new bridge starts on the new version, reads
   `update-state.json` on its next tick, and continues.
6. For email-claimed users only, if the new version crosses a
   minor or major boundary (not patch), bridge sends a one-line
   email summary: *"Klio updated to 0.6.0 — see klio.tech/changelog#0.6.0"*.

### Notify mode (opt-down)

Same flow as apply mode through step 3, but step 4 just writes
`update-state.json` with `last_known_available_version` set, no
pull / no recreate. Dashboard banner kicks in via
`/v1/system/banners` reading the file (engine reads via the volume
mount).

### Off mode

Bridge ticker doesn't fire at all. No checks, no banners, no emails.

## Schema

**Zero new database tables.** Re-uses:
- `users.email_hash` — existing; populated when email provided.
- `users.claimed_at` — existing; set when magic-link verified.
- `~/.klio/.env` — existing; gains three new vars.
- `~/.klio/update-state.json` — new file (only on disk, not DB).

### `~/.klio/update-state.json` shape

```json
{
  "current_version": "0.6.0",
  "last_check_at": "2026-05-07T13:14:15Z",
  "last_check_error": null,
  "last_known_available_version": "0.6.1",
  "last_applied_version": "0.6.0",
  "last_applied_at": "2026-05-07T07:00:00Z",
  "last_apply_error": null
}
```

Mode 0644 — readable by all containers that mount `~/.klio` (bridge
writes; engine + trust-app read for banner / `klio status` surfaces).

### `~/.klio/.env` additions

| Var | Default | Source |
|---|---|---|
| `KLIO_AUTO_UPDATE` | `apply` | `klio configure auto-update {apply,notify,off}` |
| `KLIO_UPDATE_CHECK_INTERVAL_SECS` | `21600` (6h) | configure (rare) |
| `KLIO_NOTIFY_BACKEND` | `smtp` (prod) / `log` (dev) | already exists for magic-link |

### Compose template additions

The trust-app and bridge services need `~/.klio` volume-mounted so
they can read `update-state.json`:

```yaml
trust-app:
  volumes:
    - ${HOME}/.klio:/host/.klio:ro
bridge:
  volumes:
    - ${HOME}/.klio:/host/.klio:rw
```

(Bridge already has `klio-bridge-data:/data` for credentials. Adding
`~/.klio:/host/.klio:rw` is for the state file.)

## REST endpoints

### `GET /v1/system/banners` (new)

Authenticated. Returns active banners for the current user:

```json
{
  "banners": [
    {
      "kind": "claim_email",
      "severity": "info",
      "title": "Claim your account",
      "body": "Drop your email so we can reach you for security updates.",
      "action": {"label": "Claim", "form": {"endpoint": "/v1/users/login/start", "fields": ["email"]}}
    }
  ]
}
```

Logic:
- If `users.claimed_at IS NULL` AND `users.email_hash IS NULL` → emit `claim_email` banner.
- (Future kinds — `update_available` for notify mode, `update_failed` after a
  bad apply — added when needed.)

### Existing endpoints — no changes

- `POST /v1/users/login/start` — magic-link send. Already exists.
- `POST /v1/users/login/verify` — magic-link claim. Already exists.

## CLI surface (npm)

```
klio init                     # Phase 6 gains the email sub-prompt
klio configure email <addr>   # post-install email-claim alias
klio configure auto-update {apply, notify, off}
klio update --check           # one-shot version check, prints diff
klio update --to-latest       # one-shot manual apply
klio update --to-version X    # roll forward / back to specific
```

`configure` is a new top-level subcommand; we already have
`update` from 0.5.0.

## Failure modes

| Failure | Behavior |
|---|---|
| Magic-link email send fails | Init still succeeds. User row stays anonymous. Banner reminds them to retry. |
| npm registry unreachable during version check | Bridge logs warn, tick exits cleanly, `last_check_error` written. Next tick retries. |
| `docker compose pull` rate-limited | Apply fails; `last_apply_error` written; user can manually retry via `klio update --to-latest`. |
| New engine image fails health-check after auto-apply | Container restarts up to 3× (compose default), then exits. User sees broken state — manually `klio update --to-version <previous>` to roll back. (Auto-rollback is a v0.7 feature.) |
| Update mid-curator-tick | APScheduler `max_instances=1` + curator's per-user `asyncio.Lock` — the in-flight tick completes cleanly before the engine container is killed by `compose up -d --no-deps`. New engine starts; next tick proceeds normally. |
| Bridge ticker fires twice in rapid succession (clock skew, etc.) | Single-flight via a per-instance lock on the update goroutine. Second invocation no-ops. |
| User runs `klio update --to-latest` manually while ticker is mid-update | The CLI's `klio update` shells out to compose; compose internally serializes. Worst case: the second pull hits the docker daemon's existing pull and de-dupes. No corruption. |

## Testing

### Engine

`engine/tests/test_api_system_banners.py` (new) — pin the
`/v1/system/banners` shape:
- unclaimed user → returns `claim_email` banner
- claimed user → returns no banners
- auth required (401 without bearer)

### npm

`npm/tests/init.test.ts` extended — Phase 6 email prompt:
- Skip path produces `provision_user(..., email=None)` call.
- Email path produces `provision_user(..., email=<addr>)` AND
  follows up with `POST /v1/users/login/start`.
- Garbage email (no `@`) re-prompts via `askConfirm`-style validator.

`npm/tests/update-cli.test.ts` (new) — CLI surface:
- `klio update --check` prints diff against fake registry response.
- `klio update --to-version X` writes the version to compose template
  + runs pull + up.
- `klio configure auto-update apply` / `notify` / `off` round-trips
  through `~/.klio/.env`.

### Bridge

`bridge/internal/daemon/updater_test.go` (new) — version-check + apply:
- Stub HTTP client returns "0.6.1" → ticker invokes pull + recreate.
- Stub returns "0.6.0" (current) → ticker no-ops.
- Stub times out → ticker writes `last_check_error`, exits cleanly.
- `apply` vs `notify` mode → only `apply` invokes pull + recreate.
- `off` mode → ticker doesn't run at all.

## Out of scope (v0.6 deferred)

- **GitHub OAuth.** Engine has no OAuth flow today. Adding it
  requires registering a klio-tech OAuth app, building device-flow
  (the npm CLI can't easily host a callback), and integrating with
  the engine's existing auth chain. Estimated 3 days. Will land in
  v0.7 if user-pull is significant.
- **Auto-rollback on healthcheck failure.** Watchtower-style failover.
  v0.7. The current "compose restarts 3 times then gives up" is good
  enough for v0.6 since rollback is one CLI command.
- **`klio cloud login`.** When Klio Cloud is real (currently waitlist-
  only on klio.tech/cloud), this lands as part of that launch.
- **Telemetry beyond version-check.** No usage metrics, no error
  tracking, no perf counters. Version-check is opt-out via
  `KLIO_UPDATE_CHECK_INTERVAL_SECS=0`.
- **Banner dismissal.** Users can't dismiss the claim-email banner
  (yet). The right answer is to claim. v0.7 may add a "remind me
  later" with a 24h cooldown.
- **Email rate-limiting / unsubscribe.** v1 emails users for major
  versions only and never more than once per release. v0.7 adds
  unsubscribe link.

## Compatibility

- **Existing 0.5.x users.** No breaking changes. They get all the new
  defaults (`KLIO_AUTO_UPDATE=apply`, etc.) on their next `klio init`
  re-run. Existing `users.claimed_at IS NULL` rows trigger the
  banner and the email prompt at next init.
- **Pre-0.5.0 users.** Theoretical (they'd need to be running 0.4.x
  manually). Their compose template doesn't have the volume mount
  for `~/.klio` into bridge / trust-app. `klio init` re-render
  fixes that.
- **Pre-existing `update-state.json`.** Doesn't exist before this.
  Bridge creates on first tick; missing-file is treated as "fresh
  install, current_version = whatever's running, no update history".
