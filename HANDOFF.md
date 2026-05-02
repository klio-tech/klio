# Klio v0 — Handoff Notes

This document is the source of truth for what was built locally during the
2026-05-02 session. The repo at `/Users/thakurg/Me/klio` contains the full
Phase A through L implementation against the design and plan in
`docs/plans/`.

## What's running

```
docker compose ps
  klio-postgres  pgvector/pgvector:pg16  127.0.0.1:5433  (healthy)
  klio-redis     redis:7-alpine          127.0.0.1:6380  (healthy)
```

## Test status (last run)

| Component | Tests | Status |
|---|---|---|
| `engine/` (Python, FastAPI, Postgres, KMS, audit chain, ACL, recall, ingest) | **81** | ✅ all passing |
| `bridge/` (Go, daemon + CLI + MCP shim + hooks + backfill) | **40+ across 13 packages** | ✅ all passing |
| `trust-app/` (Next.js 15, App Router, security pages) | typecheck + production build | ✅ both green |

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

### 1. Bring up dependencies
```bash
cd /Users/thakurg/Me/klio
docker compose up -d
```

### 2. Run the engine
```bash
cd /Users/thakurg/Me/klio/engine
source .venv/bin/activate
KLIO_DATABASE_URL="postgresql+asyncpg://klio:klio_dev_password@127.0.0.1:5433/klio" \
KLIO_JWT_SIGNING_KEY="dev-secret" \
KLIO_EMBEDDING_MODEL="stub" \
KLIO_EXTRACTION_MODEL="stub" \
KLIO_REDIS_URL="redis://127.0.0.1:6380/0" \
python scripts/dev_server.py
```

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
