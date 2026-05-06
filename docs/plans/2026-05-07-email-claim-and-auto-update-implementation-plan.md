# Email claim + auto-update Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development if same-session) to implement this plan task-by-task.

**Goal:** Ship v0.6.0 — gate the wow-moment behind a soft email-claim prompt, and run an auto-updater inside `klio-bridge` that pulls + recreates the stack on a 6-hour cadence (default `apply`, opt-down to `notify` or `off`).

**Architecture:** The bridge daemon gains a second APScheduler-equivalent ticker that hits `https://registry.npmjs.org/@klio-tech/klio/latest` and, when a newer version exists, shells out to `docker compose pull && up -d --no-deps engine bridge trust-app`. State is a single JSON file at `~/.klio/update-state.json` — no DB tables. Email claim re-uses the existing `POST /v1/users/login-link` magic-link path; the npm CLI prompts during Phase 6 and follows up with the link send. A new tiny `GET /v1/system/banners` endpoint drives a top banner in the trust-app dashboard reminding unclaimed users to claim.

**Tech Stack:** Go 1.22 (bridge ticker) · Python 3.12 / FastAPI (engine endpoint) · TypeScript 5 / Node 20 (npm CLI) · Next.js 16 / React 19 (trust-app banner) · Docker Compose for image lifecycle.

**Companion design doc:** `docs/plans/2026-05-07-email-claim-and-auto-update-design.md` — read it first.

---

## Conventions

- Every task is **TDD**: failing test first → red → minimal impl → green → commit.
- **One commit per task.** Conventional-commit message: `feat(engine):`, `feat(npm):`, `feat(bridge):`, `feat(trust-app):`, `chore:`, `docs:`.
- **Do NOT push** to GitHub until the user explicitly approves at the very end (Section G Step 4).
- All file paths are absolute relative to the repo root (`/Users/thakurg/Me/klio`).
- Engine tests use `uv run pytest <path> -v`. Npm tests use `npm test`. Go tests use `go test ./...`.
- Bridge tests must use the existing `minTicker` interface stub pattern — see `bridge/internal/daemon/ticker.go` for the shape.

---

# Section A — Engine: `GET /v1/system/banners`

Self-contained, fast, fewest deps. Ship first to unblock the trust-app banner work in Section E.

## Task A1: New `system_banners` API router skeleton

**Files:**
- Create: `engine/src/klio_engine/api/system.py`
- Modify: `engine/src/klio_engine/api/main.py` (include the new router)
- Test: `engine/tests/test_api_system.py` (new)

**Step 1: Failing test**

Create `engine/tests/test_api_system.py`:

```python
"""Tests for /v1/system/* endpoints.

Today: just `GET /v1/system/banners`. Future kinds (update_available,
update_failed) will be added as their producers land — see the
companion design doc."""
from __future__ import annotations

import pytest
from httpx import AsyncClient
from httpx._transports.asgi import ASGITransport


pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _hermetic_settings_env(monkeypatch):
    monkeypatch.setenv(
        "KLIO_DATABASE_URL",
        "postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio",
    )
    monkeypatch.setenv("KLIO_EMBEDDING_MODEL", "stub")
    monkeypatch.setenv("KLIO_EXTRACTION_MODEL", "stub")


async def test_banners_unauth_returns_401():
    from klio_engine.api.main import build_app
    app = build_app()
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        r = await c.get("/v1/system/banners")
        assert r.status_code == 401


async def test_banners_for_unclaimed_user_returns_claim_email():
    """Unclaimed user → banners list contains the claim_email kind."""
    # Seed an unclaimed user via direct provision; mint a token; hit endpoint.
    # Detailed seed pattern matches `test_api_curator.py:test_run_now_authenticated_runs_and_returns_state`.
    ...


async def test_banners_for_claimed_user_returns_empty():
    """Claimed user → no banners. Use a user with claimed_at != NULL."""
    ...
```

**Step 2: Run — expect FAIL**

```bash
cd engine && uv run pytest tests/test_api_system.py -v
```

Expected: ImportError or 404 (router not registered yet).

**Step 3: Implement**

Create `engine/src/klio_engine/api/system.py`:

```python
"""System-level metadata routes — currently `/banners`.

The banners endpoint surfaces UI-level prompts the dashboard
should render to the authenticated user. v0.6.0 ships exactly one
banner kind (`claim_email`); future kinds will be added as their
producers land (see companion design doc).

Logic — strictly cheap reads:
  - claim_email: emit when users.claimed_at IS NULL.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from klio_engine.api.auth import RequestContext, require_auth
from klio_engine.dependencies import get_session
from klio_engine.models.user import User


router = APIRouter(prefix="/v1/system", tags=["system"])


@router.get("/banners")
async def banners(
    ctx: RequestContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    user = (
        await session.execute(select(User).where(User.id == ctx.user_id))
    ).scalar_one()

    out: list[dict] = []
    if user.claimed_at is None:
        out.append({
            "kind": "claim_email",
            "severity": "info",
            "title": "Claim your account",
            "body": (
                "Drop your email so we can reach you for security and "
                "breaking-change updates. We won't spam you."
            ),
            "action": {
                "label": "Claim",
                "form": {
                    "endpoint": "/v1/auth/login-link",
                    "fields": ["email"],
                },
            },
        })
    return {"banners": out}
```

In `engine/src/klio_engine/api/main.py`, after the existing `app.include_router(...)` calls, add:

```python
from klio_engine.api.system import router as system_router
app.include_router(system_router)
```

**Step 4: Run — expect PASS**

```bash
cd engine && uv run pytest tests/test_api_system.py -v
```

**Step 5: Commit**

```bash
git add engine/src/klio_engine/api/system.py engine/src/klio_engine/api/main.py engine/tests/test_api_system.py
git commit -m "feat(engine): GET /v1/system/banners — claim_email for unclaimed users"
```

---

# Section B — Compose template additions

The bridge needs `~/.klio` writable (for `update-state.json`); the trust-app needs it readable (so its server-side fetch of `/v1/system/banners` includes the version state when relevant).

## Task B1: Add volume mounts to bridge + trust-app

**Files:**
- Modify: `npm/src/compose.ts` — engine + trust-app + bridge service blocks
- Test: `npm/tests/compose.test.ts` (extend existing)

**Step 1: Failing tests**

Append to `npm/tests/compose.test.ts`:

```typescript
test("compose body mounts ~/.klio rw into bridge so the updater can write update-state.json", () => {
  const body = renderComposeBody({
    imageTag: "0.6.0",
    jwtSigningKey: "k",
    embeddingModel: "ollama/nomic-embed-text",
    extractionModel: "ollama/qwen2.5:7b-instruct",
  });
  // Bridge service block must mount the host's ~/.klio at /host/.klio.
  // The trust-app already has a (read-only) mount of ~/.claude; we add
  // a separate ~/.klio mount specifically so update-state.json is
  // visible to all three klio containers.
  assert.match(
    body,
    /bridge:[\s\S]*?volumes:[\s\S]*?\$\{HOME\}\/\.klio:\/host\/\.klio:rw/,
  );
});

test("compose body mounts ~/.klio ro into trust-app so the dashboard can read update-state.json", () => {
  const body = renderComposeBody({
    imageTag: "0.6.0",
    jwtSigningKey: "k",
    embeddingModel: "ollama/nomic-embed-text",
    extractionModel: "ollama/qwen2.5:7b-instruct",
  });
  assert.match(
    body,
    /trust-app:[\s\S]*?volumes:[\s\S]*?\$\{HOME\}\/\.klio:\/host\/\.klio:ro/,
  );
});
```

**Step 2: Run — expect FAIL**

```bash
cd npm && npm test 2>&1 | tail -10
```

**Step 3: Implement**

In `npm/src/compose.ts`, find the bridge service block. After the existing `volumes:` block, add the new mount:

```yaml
  bridge:
    image: ${REGISTRY}/klio-bridge:${tag}
    container_name: klio-bridge
    pull_policy: missing
    depends_on:
      engine:
        condition: service_healthy
    environment:
      KLIO_API_URL: http://engine:8000
      KLIO_REDIS_URL: redis://redis:6379/0
      KLIO_LOG_LEVEL: ${KLIO_LOG_LEVEL:-INFO}
    volumes:
      - klio-bridge-data:/data
      - ${HOME}/.claude:/host/.claude:ro
      # NEW v0.6.0 — bridge writes ~/.klio/update-state.json from the
      # auto-updater ticker. Engine + trust-app read the same file via
      # their own mounts (engine, see below).
      - ${HOME}/.klio:/host/.klio:rw
    restart: unless-stopped
```

In the trust-app block:

```yaml
  trust-app:
    ...
    volumes:
      # NEW v0.6.0 — read-only mount of ~/.klio so the dashboard's
      # server-side handler can surface update state in
      # /v1/system/banners-equivalent local UI.
      - ${HOME}/.klio:/host/.klio:ro
    ...
```

**Step 4: Run — expect PASS**

```bash
cd npm && npm test 2>&1 | tail -8
```

**Step 5: Commit**

```bash
git add npm/src/compose.ts npm/tests/compose.test.ts
git commit -m "feat(npm): mount ~/.klio into bridge (rw) + trust-app (ro)"
```

---

# Section C — Bridge auto-updater (Go)

The meatiest section. Six tasks: state file, version-check, apply, ticker wiring, integration smoke, email notify-on-major.

## Task C1: `internal/updater/state.go` — read/write `update-state.json`

**Files:**
- Create: `bridge/internal/updater/state.go`
- Test: `bridge/internal/updater/state_test.go`

**Behaviour:**

```go
type State struct {
    CurrentVersion              string    `json:"current_version"`
    LastCheckAt                 time.Time `json:"last_check_at"`
    LastCheckError              string    `json:"last_check_error,omitempty"`
    LastKnownAvailableVersion   string    `json:"last_known_available_version,omitempty"`
    LastAppliedVersion          string    `json:"last_applied_version,omitempty"`
    LastAppliedAt               time.Time `json:"last_applied_at,omitzero"`
    LastApplyError              string    `json:"last_apply_error,omitempty"`
}

// Read returns the stored state, or a fresh State{CurrentVersion: ...} 
// if the file is missing.
func Read(path string) (State, error)

// Write atomically writes the state to disk (write-temp + rename).
// Mode 0644.
func Write(path string, s State) error
```

**Tests:** missing-file → fresh state, round-trip, atomic write doesn't leave half-written file on disk on simulated crash.

**Commit:** `feat(bridge): updater state file read/write`

## Task C2: `internal/updater/check.go` — npm-registry version check

**Files:**
- Create: `bridge/internal/updater/check.go`
- Test: `bridge/internal/updater/check_test.go`

**Behaviour:**

```go
// Check returns the latest published version of the npm package, or
// an error. 10s timeout.
func Check(ctx context.Context, client *http.Client) (string, error)

// IsNewer reports whether `latest` is strictly greater than
// `current` per semver. Treats invalid input (anything non-semver)
// as "false" — never auto-applies on bogus version strings.
func IsNewer(current, latest string) bool
```

The HTTP client is injected so tests stub it. Production wires
`http.DefaultClient` with the timeout.

**Tests:** stub returns `{"version":"0.6.1"}` → check returns
`"0.6.1"`. Stub returns malformed JSON → returns error. Network
timeout → returns error. `IsNewer("0.5.4","0.5.4")` → false.
`IsNewer("0.5.4","0.5.3")` → false. `IsNewer("0.5.4","0.6.0")` → true.
`IsNewer("0.5.4","not-semver")` → false.

**Commit:** `feat(bridge): npm registry version-check`

## Task C3: `internal/updater/apply.go` — docker compose pull + recreate

**Files:**
- Create: `bridge/internal/updater/apply.go`
- Test: `bridge/internal/updater/apply_test.go`

**Behaviour:**

```go
// Apply runs `docker compose -f <composePath> pull` followed by
// `docker compose -f <composePath> up -d --no-deps engine bridge
// trust-app`. The recreate restarts the bridge itself; this method
// is expected to be called from a defer'd goroutine that has
// already written state to disk.
//
// Stdout/stderr from compose are forwarded to the io.Writer for
// the daemon's structured log.
func Apply(ctx context.Context, composePath string, log io.Writer) error
```

The compose binary is shelled out via `exec.CommandContext`. A
dependency-injection seam (a `Runner` interface) lets tests stub
the exec without spawning real docker.

**Tests:** stubbed runner returns success → Apply returns nil.
Stubbed pull failure → Apply returns wrapped error mentioning
"pull". Stubbed up failure → similar. ContextCancellation propagates.

**Commit:** `feat(bridge): docker compose pull + up driver`

## Task C4: `internal/daemon/updater_ticker.go` — wire into the daemon

**Files:**
- Create: `bridge/internal/daemon/updater_ticker.go`
- Modify: `bridge/internal/daemon/run.go` (or wherever the daemon's main loop is) to register the new ticker
- Test: `bridge/internal/daemon/updater_ticker_test.go`

**Behaviour:**

The new ticker fires every `KLIO_UPDATE_CHECK_INTERVAL_SECS` (default 21600).
On each tick:

1. Read the state file from `KLIO_UPDATE_STATE_PATH` (default `/host/.klio/update-state.json`).
2. Resolve current version (`KLIO_BRIDGE_VERSION` env, baked at image build).
3. Read `KLIO_AUTO_UPDATE` from env: `apply` (default), `notify`, or `off`.
4. If `off`, return.
5. Run check + `IsNewer`. Update `last_check_at`. On error, write `last_check_error`, return.
6. If newer:
   - Write `last_known_available_version`.
   - If mode is `apply`: invoke `Apply(...)`. On success, write `last_applied_version` + `last_applied_at`. On failure, write `last_apply_error`.
   - If mode is `notify`: do nothing further (the dashboard banner reads `last_known_available_version`).
7. Persist state.

A single-flight lock protects against overlapping ticks.

**Tests:** all three modes (`apply`, `notify`, `off`); no-newer-version short-circuits cleanly; check failure writes `last_check_error`; apply failure writes `last_apply_error`.

**Commit:** `feat(bridge): updater ticker wiring`

## Task C5: Email notify on major-version transitions

**Files:**
- Modify: `bridge/internal/updater/apply.go` — after a successful apply,
  if the major-or-minor digit changed, dispatch a notification.
- Modify: `bridge/internal/daemon/updater_ticker.go` — pipe the user_id +
  email_hash from the bridge's stored credentials into the apply call.
- Engine surface — re-use existing `POST /v1/auth/login-link` if it can take
  a "you've been updated" custom body, OR add a tiny helper endpoint
  `POST /v1/system/notify-update {user_id, version}` that engine renders
  + hands to the existing notify backend.
- Test: `bridge/internal/updater/apply_test.go` extended.

**Note:** if the user is unclaimed (`email_hash IS NULL`), skip the email — there's nothing to send to.

**Commit:** `feat(bridge): email-claimed users on major version updates`

---

# Section D — npm CLI

## Task D1: `klio configure` subcommand

**Files:**
- Create: `npm/src/commands/configure.ts`
- Modify: `npm/src/cli.ts` — add `configure` to `SUBCOMMANDS`, route to handler
- Test: `npm/tests/configure.test.ts`

**Behaviour:**

```
klio configure auto-update {apply, notify, off}
klio configure email <addr>
```

Both write to `~/.klio/.env` via the existing `mergeEnvFile` helper from 0.5.0. The email variant additionally hits `POST /v1/auth/login-link` to send the magic link.

**Commit:** `feat(npm): klio configure auto-update + email subcommands`

## Task D2: Phase 6 email-prompt sub-step in `klio init`

**Files:**
- Modify: `npm/src/commands/init.ts` — extend Phase 6 with an email sub-prompt
- Modify: `npm/src/wow.ts` (or wherever the wow-moment lives) to slot the email sub-step at the end of the wow phase
- Test: `npm/tests/init.test.ts` extended

**Behaviour:**

After the wow-moment's recall-confirm prints, prompt:

```
──────────
  Stay in the loop?

  Klio is in active development — there have been four releases
  today. Drop your email and we'll send security/breaking-change
  notifications. We won't spam you.

  Email [skip] › ⏎    or    you@example.com
```

- Skip path: just `⏎` → init completes.
- Email path: validate (regex), call `POST /v1/auth/login-link`, print confirmation. Init completes either way.
- Garbage email re-prompts via existing `askConfirm`-style validator. Cap at 3 retries; on exhaustion, treat as skip.

**Commit:** `feat(npm): klio init phase 6 email-claim sub-prompt`

## Task D3: Extend `klio update`

**Files:**
- Modify: `npm/src/commands/update.ts` — add `--check`, `--to-latest`, `--to-version <X>` flags
- Test: `npm/tests/update.test.ts` extended

**Behaviour:**

- `klio update --check` reads `~/.klio/update-state.json`, compares against `npm view`, prints diff. Read-only.
- `klio update --to-latest` resolves the latest npm version, then runs `compose pull && up -d --no-deps engine bridge trust-app` against the user's `~/.klio/docker-compose.yml`. Re-renders the compose template if needed (image tags change to the new version).
- `klio update --to-version <X>` same but pinned.

**Commit:** `feat(npm): klio update --check / --to-latest / --to-version`

---

# Section E — Trust-app banner

## Task E1: Banner data fetch + render

**Files:**
- Create: `trust-app/src/lib/system-banners.ts` — server-side fetch of `/v1/system/banners`
- Modify: `trust-app/src/app/(local)/layout.tsx` — render banners above the main content
- Test: `trust-app/tests/system-banners.test.tsx` (or similar — match existing test style)

**Behaviour:**

The dashboard's local-route layout makes a server-side fetch on every page load: `GET /v1/system/banners` with the local-dev bearer token. If the response includes a `claim_email` banner, render it above the main content with an inline form (email input + "Claim" submit). Submit posts to `/v1/auth/login-link`; on success, banner replaces with "Magic link sent — check your email."

**Commit:** `feat(trust-app): claim-email banner driven by /v1/system/banners`

---

# Section F — Ship 0.6.0

## Task F1: Bump npm/package.json + recompose tests

**Files:**
- Modify: `npm/package.json` — `"version": "0.6.0"`.

**Commit:** `chore: bump @klio-tech/klio to 0.6.0`

## Task F2: README + CHANGELOG

**Files:**
- Modify: `README.md` — Status table, Roadmap, mention email-claim + auto-update.
- Modify: `CHANGELOG.md` — add 0.6.0 entry above 0.5.4.

**Commit:** `docs: 0.6.0 release notes`

## Task F3: Final code review

Spawn a code-reviewer subagent against the cumulative diff (`git diff main...HEAD` from the design-commit forward). Address any I-/M- issues.

## Task F4: User approves, then push

**Do NOT push until the user explicitly approves.**

1. `git log --oneline 2513d69..HEAD` — present the commit list.
2. Confirm: "Ready to push and publish 0.6.0?"
3. On `yes`: `git push origin main`. CI publishes container images + npm package.

---

## Verification checklist (before declaring done)

- [ ] `cd engine && uv run pytest tests/test_api_system.py -v` → green
- [ ] `cd bridge && go test ./internal/updater/... ./internal/daemon/...` → green
- [ ] `cd npm && npm test` → green (full suite, all tasks merged)
- [ ] `cd npm && npm run build` → typecheck clean
- [ ] `cd trust-app && npm run typecheck && npm run build:local && npm run build:public` → both build targets green
- [ ] Manual smoke: `klio configure auto-update notify` + restart bridge → ticker writes to `~/.klio/update-state.json` without applying
- [ ] Manual smoke: `klio configure email user@example.com` → engine logs the magic-link in dev mode
- [ ] Manual smoke: visit `http://127.0.0.1:3000` for an unclaimed user → claim-email banner renders
- [ ] Final code review subagent approves
- [ ] User says "push"
