# Klio v0 — Handoff Notes

This document is the source of truth for what was built locally during the
2026-05-02 session. The repo at `/Users/thakurg/Me/klio` contains the full
Phase A through L implementation against the design and plan in
`docs/plans/`, plus the per-space pluggable embedding architecture
documented in [docs/embedding-models.md](docs/embedding-models.md).

## What's running

Postgres + Redis live in Docker. Ollama is **platform-aware**:

- **macOS** → native install via `brew install ollama` (uses Metal — much faster than Docker on Apple Silicon, where the Docker VM cannot reach Metal)
- **Linux** → Docker'd Ollama via `docker compose --profile docker-ollama up -d ollama` (CPU-only by default; opt-in profile)

```
# Postgres + Redis
docker compose ps
  klio-postgres  pgvector/pgvector:pg16  127.0.0.1:5433  (healthy)
  klio-redis     redis:7-alpine          127.0.0.1:6380  (healthy)

# Ollama: native on macOS (this machine)
brew services list | grep ollama
  ollama  started thakurg
curl 127.0.0.1:11434/api/tags          # responds with installed models
```

`make ollama` picks the right backend automatically based on `uname -s`.
The engine always reads `KLIO_OLLAMA_API_BASE` (default `127.0.0.1:11434`),
so it doesn't care which backend is serving.

## Test status (last run)

| Component | Tests | Status |
|---|---|---|
| `engine/` (Python, FastAPI, Postgres, KMS, audit chain, ACL, recall, ingest, access requests, notarization, login-link, **per-space embeddings**, **reembed**) | **97 stub + 2 real-Ollama** | ✅ all passing |
| `bridge/` (Go, daemon + CLI + MCP shim + hooks + backfill + cert pinning + realtime subscriber + **klio reembed**) | **50+ across 13 packages** | ✅ all passing |
| `trust-app/` (Next.js 15, App Router, security pages, access-requests page) | typecheck + production build | ✅ both green |

## Phases delivered

| Phase | Topic | Status |
|---|---|---|
| 0 | Workspace + Docker (Postgres+pgvector + Redis) | ✅ |
| A | Engine schema, ORM models, KMS envelope encryption, audit hash chain | ✅ |
| B | Coordinator: provision, magic-link, JWT, refresh-token rotation, audit writer | ✅ |
| C | Engine public APIs (spaces, ACL, entries, recall) with tenant isolation | ✅ |
| D | Extraction pipeline (PII scrubber, fact extractor, S3 sink, transcript ingest) | ✅ |
| E | Daemon (Go): config, keychain, cloud client, SQLite cache, agent registry, socket server | ✅ |
| F | MCP shim and seven tools dispatcher | ✅ |
| G | Real-time pub/sub via Redis | ✅ |
| H | `klio init` bootstrap with Claude Code adapter | ✅ |
| I | Trust app (Next.js): landing, magic-link verify, spaces, ACL view | ✅ |
| J | Claude Code hooks + plugin (skills + slash commands) | ✅ |
| K | Backfill from `~/.claude/projects` | ✅ |
| L | Security artifacts (security.txt, threat model, VDP scaffold) | ✅ |

## Live end-to-end demos verified during this session

1. **Anonymous provision → refresh → recall** through MCP shim:
   `npx-style installation flow returns user_id, agent_id, default_space_id, api_key.`
   `klio-mcp tools/list returned all 7 tools verbatim.`
2. **Cross-tenant adversarial test:** user A's secret entry never surfaced
   in user B's recall — verified at the SQL+ACL layer.
3. **Real-time pub/sub:** wrote an entry; subscriber received `entry.created`
   frame within ms with full payload.
4. **klio init full flow:** patched empty `~/.claude/settings.json` with 6
   hooks + the Klio MCP server entry; idempotent on re-run; restored from
   backup on `klio uninstall`.
5. **Hooks live:** `UserPromptSubmit` with "remember that I prefer Bun"
   wrote a `memory` row in Postgres at the timestamp of the hook firing.
   `PostToolUse` and `SubagentStop` wrote `observation` rows.
6. **Backfill:** ingested 2 fake session JSONL files; engine extracted 4
   typed entries (1 memory, 1 decision, 2 plans) into a new `klio-demo`
   space; all decryptable on read.
7. **Trust app:** Next.js production build succeeds; live curl of `/`
   returned the SSR-rendered Klio landing page with the magic-link form.

## How to run it again

### 0. One-time setup (idempotent)

```bash
cd /Users/thakurg/Me/klio
make first-run     # docker compose up + ollama (native on macOS) + migrate + build binaries
```

`klio init` is fully automated end-to-end — running it from inside the
repo root also writes:

- `~/.klio/local-dev.env` (mode 0600) — per-user dotenv with the JWT
  signing key, user_id, and agent_id needed by the trust-app docker
  service to auto-login as you. Survives across machines via your
  home-dir backup.
- `<repo-root>/.env` (mode 0600) — the same content, mirrored into
  the project root so `docker compose up -d trust-app` picks it up
  automatically (Compose's default env-file pickup).

Skip with `klio init --no-env-file` if you manage env vars elsewhere.
The CLI prints both paths on success and a one-line copy-paste hint:
`Browse memories: docker compose up -d trust-app && open http://127.0.0.1:3000`.

After running `klio init` (step 5), Claude Code's `~/.claude/settings.json`
gains three things automatically:

| Block | What it does | Why we patch it |
|---|---|---|
| `mcpServers.klio` *(removed by post-fix init)* | Legacy slot — Claude Code never read it | Cleaned up automatically during migration |
| `hooks` (6 events) | Auto-capture every prompt + tool call into Klio | This is what makes memory passive |
| `permissions.allow` (7 `mcp__klio__*` tools) | Pre-approves each Klio MCP tool so users don't see "Do you want to proceed?" prompts | First-run UX |

The MCP server registration itself lives in `~/.claude.json` (Claude Code's
master config), written via the official `claude mcp add-json` CLI. We do
not edit `~/.claude.json` directly.

### 1. Bring up dependencies

```bash
cd /Users/thakurg/Me/klio
docker compose up -d postgres redis
make ollama          # macOS: brew install + start; Linux: docker compose profile
make models-pull     # nomic-embed-text (274 MB) + qwen2.5:7b-instruct (4.7 GB)
```

Note: `docker compose up -d` no longer starts Ollama by default — the
service is gated behind the `docker-ollama` profile because on macOS,
running Ollama in Docker forfeits Metal acceleration.

### 2. Run the engine

Easiest path: `make engine` reads the right env automatically.

Manual:
```bash
cd /Users/thakurg/Me/klio/engine
source .venv/bin/activate
KLIO_DATABASE_URL="postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio" \
KLIO_JWT_SIGNING_KEY="dev-secret" \
KLIO_EMBEDDING_MODEL="ollama/nomic-embed-text" \
KLIO_EXTRACTION_MODEL="ollama/qwen2.5:7b-instruct" \
KLIO_OLLAMA_API_BASE="http://127.0.0.1:11434" \
KLIO_REDIS_URL="redis://127.0.0.1:6380/0" \
python scripts/dev_server.py
```

For tests / hermetic runs without Ollama, use `KLIO_EMBEDDING_MODEL="stub"`
and `KLIO_EXTRACTION_MODEL="stub"`.

### 3. Build CLI binaries
```bash
cd /Users/thakurg/Me/klio/bridge
go build -o /tmp/klio ./cmd/klio
go build -o /tmp/klio-mcp ./cmd/klio-mcp
```

### 4. Initialize Klio in a sandboxed HOME
```bash
HOME_TMP=$(mktemp -d)
mkdir -p "$HOME_TMP/.claude" && echo '{}' > "$HOME_TMP/.claude/settings.json"
KLIO_USE_FILE_KEYCHAIN=1 KLIO_API_URL="http://127.0.0.1:8000" \
  HOME="$HOME_TMP" /tmp/klio init --mcp-bin /tmp/klio-mcp
```

### 5. Start the daemon
```bash
KLIO_USE_FILE_KEYCHAIN=1 KLIO_API_URL="http://127.0.0.1:8000" \
  HOME="$HOME_TMP" /tmp/klio daemon &
```

### 6. Talk MCP through the shim
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | KLIO_SOCKET_PATH="$HOME_TMP/.klio/bridge.sock" /tmp/klio-mcp
```

### 7. Run the trust app
```bash
cd /Users/thakurg/Me/klio/trust-app
KLIO_ENGINE_URL="http://127.0.0.1:8000" KLIO_JWT_SIGNING_KEY="dev-secret" \
  ./node_modules/.bin/next dev -p 3001
# open http://127.0.0.1:3001
```

## Pluggable embedding architecture (added after the original v0)

Klio is now dim-agnostic at the schema level. Each space pins its own
embedding model and dimension at creation time, and writes go to a
per-dim shadow table (`entry_embeddings_768`, `_1024`, `_1536`). This
unlocks:

- A self-hoster on a small laptop using free `ollama/nomic-embed-text` (768d)
- A Pro user using `text-embedding-3-small` (1536d, paid OpenAI)
- Both side-by-side on the same engine, no schema change required

To switch a space's model:

```bash
/tmp/klio reembed --space default --to ollama/snowflake-arctic-embed2
```

See [docs/embedding-models.md](docs/embedding-models.md) for the full
registry, shadow-table layout, and "adding a new dim" procedure.

## All five originally-flagged TODOs are now closed

| # | Item | Commit |
|---|---|---|
| 1 | `/v1/auth/login-link` lookup-by-email-hash + trust app integration | `7edf1f1` |
| 2 | Daemon Redis subscriber wired to `daemon.Run` (auto-subscribes to user's spaces, refreshes every 5 min) | `8b6373f` |
| 3 | `request_access` end-to-end: engine endpoints, model+migration, trust app surface, daemon's `RequestAccess` wired | `822a5e8` |
| 4 | TLS cert pinning on daemon HTTPS client via `KLIO_PINNED_CERT_SHA256` env (additive to CA validation) | `e8b0c68` |
| 5 | OpenTimestamps notarization: hourly cron, `audit_notarizations` table, OTS calendar submission with stub fallback | `2f95252` |

Live verifications captured per commit. All 95 engine + 50+ bridge tests pass.

## What was deliberately not done locally (external accounts / billing)

The plan's Phase L items below require external accounts and billing, so I
flagged and skipped them — they're operational, not engineering:

- GitHub repo creation under `klio-tech` org
- npm scope `@klio` reservation, PyPI `klio` reservation
- Real AWS KMS keys + S3 bucket (we use `moto` mock locally)
- Railway project provisioning (we use Docker Compose locally)
- Cloudflare Workers / WAF deployment
- Production domain DNS and TLS for `*.klio.tech`
- Resend / Postmark account for magic-link emails (logged via structlog locally)
- Sentry account
- HackerOne / Intigriti VDP listing
- SOC2 Type 1 audit kickoff
- Apple Developer Program / Windows EV cert (irrelevant given our `npx`-only
  distribution choice)

When you're ready to ship to a domain, those are the boxes to tick.

## Directory layout (post-build)

```
klio/
├── HANDOFF.md                  # this file
├── README.md
├── docker-compose.yml          # Postgres + Redis (5433, 6380 to dodge user's existing instances)
├── docs/
│   ├── plans/                  # design + implementation plans (copied from Agent Memory)
│   └── security/               # threat-model.md + triage-runbook.md
├── infra/
│   └── sql/init.sql            # Postgres extensions on first boot
├── engine/                     # Python 3.12 / FastAPI / SQLAlchemy / pgvector
│   ├── pyproject.toml
│   ├── alembic.ini, alembic/
│   ├── src/klio_engine/
│   │   ├── api/                # health, users, spaces, entries, recall, agents, audit, ingest
│   │   ├── audit/              # hash-chain, writer
│   │   ├── auth/               # JWT, refresh, magic-link
│   │   ├── crypto/             # envelope, KMS client
│   │   ├── models/             # 8 ORM models
│   │   ├── schemas/            # pydantic
│   │   └── services/           # acl, embeddings, entries, recall, extractor, pii, raw_events, publisher
│   ├── tests/                  # 81 tests, all passing
│   └── scripts/dev_server.py   # uvicorn + moto for local KMS/S3
├── bridge/                     # Go 1.22 daemon + CLI + MCP shim
│   ├── go.mod
│   ├── cmd/{klio,klio-mcp,realtime_e2e}/
│   └── internal/
│       ├── agentadapters/      # Claude Code adapter (extensible)
│       ├── backfill/           # walker + runner + checkpoint + HTTP client
│       ├── bootstrap/          # klio init / klio uninstall
│       ├── cache/              # SQLite cache, pending writes, agent bindings
│       ├── cloud/              # HTTPS client for engine
│       ├── config/             # default < file < env precedence
│       ├── daemon/             # orchestrator with mcp.Backend impl
│       ├── hooks/              # 6 hook handlers + socket backend
│       ├── keychain/           # OS keychain + AES-256-GCM file fallback
│       ├── mcp/                # types, 7 tools, dispatcher
│       ├── realtime/           # Redis pub/sub subscriber
│       ├── socket/             # unix-domain-socket server
│       └── version/
├── claude-plugin/              # plugin.json + 3 skills + 4 slash commands
└── trust-app/                  # Next.js 15 / TypeScript / React 19
    ├── next.config.ts
    ├── package.json
    ├── public/.well-known/security.txt
    └── src/
        ├── app/                # /, /verify, /spaces, /spaces/[id], /security, /security/hall-of-fame
        ├── components/login-form.tsx
        └── lib/{api.ts,session.ts}
```

## What's next (operational)

If you want to take this from "demo on my laptop" to "live on klio.tech":

1. Reserve `@klio` on npm, `klio` on PyPI, `klio` and `klio-tech` on GitHub.
2. Create the AWS account, provision real KMS + S3 (the engine code already
   talks to either real AWS or moto — set `KLIO_KMS_KEY_ARN` to the real one).
3. Spin up Railway projects (engine + Postgres + Redis) and a Cloudflare
   zone for `*.klio.tech`.
4. Wire Resend/Postmark for the magic-link flow — replace the dev-mode
   `structlog.info` in `coordinator/...auth/magic_link` with the real send.
5. Cut a release of the bridge binary signed with an Ed25519 key, publish
   to npm under `@klio/cli` so `npx klio init` becomes the canonical install.
6. Submit to the MCP server registries (Smithery / Glama / awesome-mcp).
7. Run the pre-launch private security review (3 trusted reviewers, 2 weeks).
8. Public launch.

Ship it.
