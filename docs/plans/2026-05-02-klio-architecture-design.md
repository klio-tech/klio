# Klio — Architecture & v0 Design

**Date:** 2026-05-02
**Status:** Approved (Abhishek + Claude co-founder session)
**Authors:** Abhishek Singh (Oppla.ai / Vex), Claude

> The product Klio is a separate-brand product spinning out of Vex's existing engine. This document is the architecture and v0 design specification, derived from a brainstorming session on 2026-05-02. The strategic context (why bifurcate, why MCP-first, why open core) is in the companion document [`2026-05-02-memory-product-direction-design.md`](../../2026-05-02-memory-product-direction-design.md). The earlier MCP-server-only sketch is in [`2026-05-02-memory-mcp-server-plan.md`](../../2026-05-02-memory-mcp-server-plan.md) — superseded by this document.

---

## Context

### What we are building

**Klio is the substrate where AI agents collaborate.** Phase 1 enables agent-to-agent coordination through user-owned shared workspaces (Claude Code talks to Cursor talks to Codex talks to Antigravity). Phase 2 ingests external sources (Slack, Notion, Gmail, Drive) into the same substrate. Memory is a primitive of the substrate — not the headline.

Pitch line: **"Your AI agents, finally talking to each other."**

### Why this positioning

1. **Memory alone is not defensible.** OpenAI and Anthropic will eventually ship first-party memory for their own surfaces. A neutral cross-agent substrate is something they structurally cannot build, because each is its own walled garden.
2. **The demo is wildly more compelling.** "Claude planned it, Cursor implemented it, Codex reviewed it — they all knew what each other did" lands harder than "agent has memory."
3. **Vex's engine already has the foundation.** The existing session_memories subsystem (pgvector, fact extraction, dedup, supersedes-graph, scope levels) covers ~70% of what's needed. The Klio engine reuses these architectural patterns in a new clean codebase.

### Locked decisions (do not re-litigate)

| Decision | Locked Value |
|---|---|
| Brand | Klio · klio.tech · github.com/klio-tech |
| Strategic relationship to Vex | Bifurcation, not pivot. Vex stays as enterprise reliability. |
| Distribution philosophy | Open core. Client/protocol/reference engine open (Apache 2.0). Cloud-only operational and intelligence layer proprietary. |
| Pricing | Free for individuals, paid B2B2C, self-host always free. |
| Phases | P1 = collaboration · P2 = external source ingestion |
| Demo mode | Real-time observation via sub-second pub/sub (Option B from brainstorm) |
| Hierarchy | User → Space (user-named) → Session → Entry |
| Per-space ACL | Core feature, not optional |
| Access grant flow | Auto-prompt primary · NL via trusted agent · trust app as audit fallback (all three) |
| Onboarding | Anonymous-first; claim later via magic link |
| Security tier | Tier 2 at launch (standard hardening + agent-substrate threat model + VDP), Tier 3 (paid pen test, SOC2) within 8 weeks post-launch |
| Engine architecture | New `klio-engine` codebase, Vex-pattern-inspired, OSS-first (the *same* engine cloud runs) |
| Launch posture | Public launch, OSS self-host + cloud both day-1, target 1000+ agents in launch window |
| Launch deployment | Single-region (US-East) at launch; multi-region post-launch |
| Compute platform | Railway (managed services, minimal IaC) |
| Bug bounty | VDP only at launch (no funded bounty); funded program post-seed |

---

## Section 1 — System Architecture

### Macro shape

```
┌────────────────────────── USER MACHINE ──────────────────────────┐
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐    │
│   │  klio-bridge  (local daemon, listens on localhost:7878) │    │
│   │  ─────────────────────────────────────────────────────  │    │
│   │   • MCP server (speaks MCP to local agents)             │    │
│   │   • Credential store (OS keychain)                      │    │
│   │   • Local cache (SQLite, hot-reads)                     │    │
│   │   • WebSocket fan-in/fan-out (sub-second pub/sub)       │    │
│   │   • Auto-discovers and auto-configs installed agents    │    │
│   │   • Local-first mode (works offline, syncs when online) │    │
│   └────────┬─────┬─────────┬───────────┬────────────────────┘    │
│            │     │         │           │                         │
│         Claude  Cursor   Codex     Antigravity   ← MCP clients   │
│         Code                                                     │
└────────────────────────────┬─────────────────────────────────────┘
                             │   TLS 1.3, mutual auth, signed
                             │   (or local-only — never leaves machine)
                             ▼
┌─────────────────── api.klio.tech (cloud) ────────────────────────┐
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  klio-edge  (Cloudflare Workers / edge layer)            │    │
│  │  • TLS termination · WAF · rate limit · DDoS · auth      │    │
│  │  • Routes to Railway · WebSocket upgrade                 │    │
│  └──────────┬────────────────────────────────────┬──────────┘    │
│             │                                    │                │
│             ▼                                    ▼                │
│  ┌──────────────────────┐         ┌──────────────────────────┐   │
│  │  klio-coordinator    │◄────────│  klio-realtime           │   │
│  │  (REST + identity)   │         │  (WebSocket fan-out)     │   │
│  │  • Provisioning      │         │  • per-space channels    │   │
│  │  • ACL enforcement   │         │  • presence              │   │
│  │  • Magic link auth   │         │  • backed by Redis       │   │
│  │  • Audit log writer  │         │    pub/sub               │   │
│  └──────────┬───────────┘         └────────────┬─────────────┘   │
│             │                                  │                  │
│             └──────────────┬───────────────────┘                  │
│                            ▼                                      │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │  klio-engine  (the OSS-licensed core)                      │   │
│  │  • Postgres + pgvector (entries, embeddings, ACL)          │   │
│  │  • Fact extraction pipeline (LiteLLM)                      │   │
│  │  • Dedup + supersedes-graph                                │   │
│  │  • Plugin interface for closed-source extensions ↓         │   │
│  └────────┬───────────────────────────────────────────┬───────┘   │
│           │                                           │           │
│           ▼ (cloud-only plugins, proprietary)         ▼           │
│  ┌──────────────────────┐         ┌──────────────────────────┐   │
│  │  Advanced retrieval  │         │  Cross-agent intelligence │   │
│  │  (closed source)     │         │  (closed source)         │   │
│  └──────────────────────┘         └──────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  Object store (S3) — raw events, immutable, encrypted    │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

┌────────────────────── app.klio.tech (trust app) ─────────────────┐
│  Magic-link auth · per-space ACL · audit log · export · delete   │
└──────────────────────────────────────────────────────────────────┘
```

### Components

| Component | License | Repo | Purpose |
|---|---|---|---|
| `klio-bridge` | Apache 2.0 | `klio-tech/bridge` | Local daemon. Single install, every agent connects via localhost. |
| `klio-mcp` | Apache 2.0 | `klio-tech/mcp` | MCP server (embedded in bridge, also standalone). |
| `klio-sdk-ts` / `klio-sdk-py` | Apache 2.0 | `klio-tech/sdk-{ts,py}` | Programmatic clients. |
| `klio-engine` | Apache 2.0 | `klio-tech/engine` | The substrate: Postgres+pgvector, extraction, ACL, pub/sub, plugin host. **Same code we run.** |
| `klio-protocol` | Apache 2.0 | `klio-tech/protocol` | OpenAPI specs, MCP tool schemas, contract tests. |
| `klio-coordinator` | Proprietary | private | Cloud-only. Identity/provisioning/billing/admin. |
| `klio-realtime` | Proprietary | private | Cloud-only. WebSocket fan-out backed by Redis. |
| `klio-edge` | Proprietary | private | Cloudflare Workers. WAF, rate limit, routing, TLS. |
| `klio-trust-app` | Apache 2.0 (UI) | `klio-tech/trust-app` | `app.klio.tech`. UI is open so users can verify what it shows. |

### Deployment topologies

The same `klio-engine` binary supports three deployments. The protocol is identical across all three.

1. **Cloud** — Klio runs the production cluster (US-East at launch). Most users land here by default.
2. **Self-hosted** — User runs the engine on their own infra. `docker compose up`.
3. **Local-only** — Daemon ships a standalone engine bundled. No cloud, no network, no telemetry.

### OSS vs cloud — the rule

**Everything in the request path that an agent or user touches is OSS.** The closed-source surface is purely the cloud-only operational and intelligence layer — multi-tenancy, advanced retrieval ranking, cross-agent intelligence, premium connectors, billing, admin. None of those are required for the protocol to work; they make the cloud version meaningfully better at scale.

The plugin interface in `klio-engine` is a typed, stable contract. Closed-source plugins implement it. OSS engine ships with reference implementations of every interface.

### Language and framework choices

| Component | Language | Framework |
|---|---|---|
| `klio-bridge` (daemon + CLI) | Go 1.22+ | net/http, gorilla/websocket, mattn/go-sqlite3 |
| `klio-mcp` (stdio shim) | Go | (same binary, different entrypoint) |
| `klio-engine` | Python 3.12+ | FastAPI + SQLAlchemy + Alembic, pgvector |
| `klio-coordinator` | Python 3.12+ | FastAPI + SQLAlchemy |
| `klio-realtime` | Go 1.22+ | gorilla/websocket + go-redis |
| `klio-edge` | TypeScript | Cloudflare Workers + Hono |
| `klio-trust-app` (frontend) | TypeScript | Next.js 15 (App Router) + Tailwind |
| `klio-trust-app` (backend BFF) | TypeScript | Next.js API routes |
| `klio-sdk-ts` | TypeScript | (zero deps beyond fetch) |
| `klio-sdk-py` | Python 3.10+ | httpx + pydantic |

**Three languages, defended:** Go for tight cross-platform binaries and high WS concurrency (daemon, CLI, realtime fan-out). Python for data and AI ecosystem dominance (engine, coordinator). TypeScript for edge (Workers) and browser (trust app, SDK).

### Infra

| Layer | Choice |
|---|---|
| Compute | **Railway** (managed services for coordinator, engine, realtime). Migration to AWS EKS by SOC2 audit. |
| Primary store | Postgres 16+ with pgvector (HNSW indexes), Railway-managed |
| Cache + pub/sub | Redis 7+ (Streams for replay buffer, Pub/Sub for fan-out), Railway-managed |
| Object store | S3-compatible (AWS S3 cloud, MinIO self-host) |
| Edge | Cloudflare (Workers, R2 for static, Turnstile for CAPTCHA, WAF) |
| KMS | AWS KMS in cloud; HashiCorp Vault in self-host |
| Observability | OpenTelemetry → Grafana Cloud (logs + traces + metrics) |
| IaC | Terraform (minimal — KMS, S3, Cloudflare); Helm for self-host |
| CI/CD | GitHub Actions + signed artifacts; OIDC to AWS (no static secrets) |
| Email (magic links) | Resend or Postmark |
| Errors | Sentry (free tier) |

---

## Section 2 — Data Model

### Entity overview

```
                     ┌────────────────────┐
                     │      User          │  durable identity. all data
                     │  id (uuid)         │  hangs off this. anonymous
                     │  email_hash?       │  until claimed.
                     │  claimed_at?       │
                     └─────────┬──────────┘
                               │
          ┌────────────────────┼─────────────────────┐
          │                    │                     │
          ▼                    ▼                     ▼
┌──────────────────┐ ┌──────────────────┐  ┌───────────────────┐
│   Agent          │ │   Space          │  │  AuditLogEntry    │
│  id, user_id     │ │  id, user_id     │  │  hash chain       │
│  kind            │ │  name, slug      │  │  immutable        │
│   (claude-code,  │ │  created_at      │  └───────────────────┘
│    cursor, …)    │ │  deleted_at?     │
│  install_id      │ └────────┬─────────┘
│  display_name    │          │
└────────┬─────────┘          │
         │           ┌────────┴────────┐
         │           │                 │
         │           ▼                 ▼
         │  ┌──────────────────┐  ┌────────────────────────┐
         │  │   Permission     │  │     Session            │
         │  │ user_id          │  │  id, user_id           │
         │  │ space_id         │  │  agent_id, space_id    │
         │  │ agent_id         │  │  started_at, ended_at  │
         │  │ scope            │  │  source_type           │
         │  │  (read|write|    │  │   (claude-code-session,│
         │  │   admin)         │  │    cursor-session, …)  │
         │  │ granted_at       │  └───────────┬────────────┘
         │  │ granted_by       │              │
         │  │ revoked_at?      │              │
         │  └──────────────────┘              │
         │                                    │
         └────────────────────────────────────┤
                                              ▼
                              ┌─────────────────────────────────┐
                              │           Entry                 │
                              │  id, user_id, space_id          │
                              │  session_id, agent_id           │
                              │  kind (memory|observation|      │
                              │        plan|decision|handoff|   │
                              │        note)                    │
                              │  content (text, encrypted)      │
                              │  embedding (vector 1536)        │
                              │  metadata (jsonb, encrypted)    │
                              │  confidence (0–1)               │
                              │  superseded_by (entry_id?)      │
                              │  created_at, deleted_at?        │
                              │  encryption_key_id              │
                              └─────────────────────────────────┘

                              ┌─────────────────────────────────┐
                              │   RawEvent (S3, immutable)      │
                              │  user_id, session_id            │
                              │  source_type, payload (encrypted)│
                              │  Used for re-extraction         │
                              └─────────────────────────────────┘
```

### Entities

- **User.** Root principal. Optional `email_hash` (we hash before storage; raw email only in transit during magic-link). `claimed_at` distinguishes anonymous from verified. `deleted_at` enables 30-day soft delete then hard cascade.
- **Agent.** A specific agent install. The triple `(user_id, kind, install_id)` is unique. `kind` is enum (`claude-code`, `cursor`, `codex`, `antigravity`, `custom`). `install_id` is a UUID generated at first contact.
- **Space.** User-named container. Every user has a `Default` space auto-created on provisioning. Slug is URL-safe.
- **Permission.** ACL row. `(user_id, space_id, agent_id, scope)` is unique. Scopes: `read` (subscribe + recall), `write` (post entries), `admin` (grant other agents). Audit-logged on every change.
- **Session.** Bounded interaction. Auto-created when an agent first writes in a space within an idle window (1 hour default). Carries `source_type`.
- **Entry.** The unit of all stored content. Six kinds, all the same shape:

| Kind | Purpose | Example | Ships in v0 |
|---|---|---|---|
| `memory` | Stable fact about user or context | "User prefers TypeScript over JavaScript" | ✓ |
| `observation` | Something the agent saw or did | "Claude edited auth.ts at 14:32" | ✓ |
| `plan` | Forward-looking intent | "Plan: 1. add JWT 2. deprecate session cookies" | ✓ |
| `decision` | Chosen path with rationale | "Using PostHog over Mixpanel — cheaper" | ✓ |
| `note` | Free-form annotation | "Reminder: env vars need rotation by Friday" | ✓ |
| `handoff` | Explicit transfer to another agent | "@cursor: implement steps 2-4 of the auth plan" | Phase 1 expansion |

- **RawEvent.** Append-only S3 object. Full transcript / tool call / hook payload before extraction. Encrypted with user's envelope key. Never returned via API directly. Exists for re-extraction and GDPR export.
- **AuditLogEntry.** Every privileged action writes a row. Each row carries `prev_hash` and `hash` (sha-256 over row + prev_hash) — a Merkle-style chain. Hourly root hash notarized to OpenTimestamps.

### Encryption

Two-layer envelope, per-user:

1. **KMS holds the master key** (AWS KMS / HashiCorp Vault). Klio engineers cannot decrypt master keys.
2. **Per-user envelope key.** On user provisioning, KMS generates 256-bit envelope key, wrapped under master key. On every write, envelope key is unwrapped (in-memory only) and used to encrypt entry's `content` and `metadata`. Embeddings are *not* encrypted (need to be searchable; mitigated via tenant-isolated vector indexes).
3. **Per-entry data key (optional).** For entries the user marks private — fresh DEK per entry, wrapped under envelope key.

Key rotation: envelope keys auto-rotate every 90 days. Old keys retained for decryption until all entries re-encrypted under new key. User can force rotation from trust app.

For self-hosted: same scheme, but master key lives in the user's local Vault / Docker secret / cloud KMS.

### Soft delete, hard delete, GDPR

- **Soft delete** (`deleted_at` set): immediately hidden from reads, embedding zeroed, audit log records action. 30-day grace.
- **Hard delete** (after 30 days, or on explicit "delete now"): row physically removed, S3 raw events purged, key material destroyed, audit log keeps tombstone (id + timestamp + actor) but no content.

GDPR satisfied: Article 17 (erasure) by hard delete; Article 20 (portability) by signed JSON export endpoint; Article 15 (access) by trust app.

### Indexes

```
entries: (user_id, space_id, created_at desc)        ← primary list view
entries: (user_id, space_id, kind, created_at desc)  ← typed feed
entries: HNSW(embedding) WITH (m=16, ef_construction=64)
entries: (superseded_by) where superseded_by IS NOT NULL
permissions: (user_id, space_id, agent_id) UNIQUE
sessions: (user_id, agent_id, started_at desc)
audit_log: (user_id, created_at desc)
```

Vector index uses HNSW with separate index per user_id partition for tenant isolation.

### Deferred to v1

- CRDT merge for concurrent edits (last-write-wins for v0)
- Threaded entries (parent_id, ships with handoff)
- Cross-space references
- Time-aware confidence decay

---

## Section 3 — Protocol & Real-Time Pub/Sub

Three surfaces: **MCP** (agent ↔ daemon, localhost), **REST** (daemon ↔ cloud), **WebSocket** (daemon ↔ cloud, real-time).

### MCP Tools (agent-facing)

| Tool | Signature | Purpose |
|---|---|---|
| `recall` | `(query, space?, kind?, limit?)` → `Entry[]` | Semantic search. Defaults to active space. |
| `remember` | `(content, space?, metadata?)` → `Entry` | Store a stable user/context fact. |
| `observe` | `(content, space?, metadata?)` → `Entry` | Log something the agent did or saw. |
| `plan` | `(content, space?, metadata?)` → `Entry` | Post a plan or intent. |
| `decide` | `(content, rationale, space?, metadata?)` → `Entry` | Record a chosen path. |
| `note` | `(content, space?)` → `Entry` | Free-form annotation. |
| `space` | `(action, name?, scope?)` → varies | Multiplexed space management (list/switch/info/request_access). |

Real-time inside MCP: when a new entry arrives in a subscribed space, daemon emits `notifications/resources/updated`. Agents that handle the notification fetch via `recall`. Agents that don't get the new entry injected as context on next user prompt ("Since your last message, Cursor posted a plan in space Klio at 14:32.").

### REST API (`/v1/`, OpenAPI 3.1)

```
# Identity & onboarding
POST   /v1/users/provision           { agent_kind, install_id, email? }
                                       → { user_id, api_key, claimed }
POST   /v1/users/{id}/claim          { email } → { magic_link_sent }
POST   /v1/users/{id}/verify         { token } → { session_token }
POST   /v1/users/{id}/rotate         → { new_api_key }
DELETE /v1/users/{id}                → { deletion_scheduled_at }

# Spaces
GET    /v1/spaces                              → [Space]
POST   /v1/spaces                  { name }    → Space
GET    /v1/spaces/{id}                         → Space + members + recent
PATCH  /v1/spaces/{id}             { name }    → Space
DELETE /v1/spaces/{id}                         → ()

# Permissions
GET    /v1/spaces/{id}/permissions             → [Permission]
POST   /v1/spaces/{id}/permissions  { agent_id, scope } → Permission
DELETE /v1/spaces/{id}/permissions/{agent_id}  → ()

# Agents
POST   /v1/agents                  { kind, install_id, name } → Agent
GET    /v1/agents                              → [Agent]
DELETE /v1/agents/{id}                         → ()
POST   /v1/agents/{id}/request-access  { space_id, scope } → AccessRequest

# Entries
POST   /v1/spaces/{id}/entries     { kind, content, metadata? } → Entry
GET    /v1/spaces/{id}/entries     ?kind=&since=&limit=         → [Entry]
POST   /v1/spaces/{id}/recall      { query, kind?, limit? }     → [Entry]
DELETE /v1/entries/{id}                                         → ()

# Real-time (upgrade)
GET    /v1/realtime  (WebSocket upgrade)  ?token=&spaces=a,b,c

# Trust + compliance
GET    /v1/audit                              → [AuditLogEntry]
POST   /v1/export                             → { archive_url, expires_at }
```

ACL is checked twice — at the coordinator (defense in depth) and inside the engine query (defense against coordinator bugs).

### WebSocket protocol

Connect:
```
GET wss://api.klio.tech/v1/realtime
Sec-WebSocket-Protocol: klio.v1
Authorization: Bearer <short-lived-token>
?spaces=space_a,space_b,space_c
```

Server fails closed: token must have `read` on every requested space, else connection rejected.

Frame types (server → client unless noted):

```jsonc
{ "type": "entry.created", "space_id": "...", "entry": { ... }, "frame_id": "..." }
{ "type": "entry.superseded", "space_id": "...", "entry_id": "...", "superseded_by": "...", "frame_id": "..." }
{ "type": "entry.deleted", "space_id": "...", "entry_id": "...", "frame_id": "..." }
{ "type": "permission.changed", "space_id": "...", "agent_id": "...", "scope": "...", "frame_id": "..." }
{ "type": "access.requested", "space_id": "...", "agent_id": "...", "scope": "...", "request_id": "..." }
{ "type": "auth.expiring", "expires_in_seconds": 300 }
{ "type": "pong" }
{ "type": "error", "code": "...", "message": "..." }

// Client → server
{ "type": "ping" }
{ "type": "ack", "frame_id": "..." }
{ "type": "auth.refresh", "token": "..." }
{ "type": "subscribe", "space_id": "..." }
{ "type": "unsubscribe", "space_id": "..." }
```

**Delivery semantics:** at-least-once for `entry.*` and `permission.*`. Server retains 7-day frame buffer per subscription (Redis Streams). Client reconnects with `?since=<last_acked_frame_id>`. If client lags > 1000 unacked frames, server emits `gap.warning` and the daemon refetches via REST. Per-connection rate limit: 100 frames/sec sustained, burst 1000.

### Authentication

| Surface | Auth |
|---|---|
| MCP (agent ↔ daemon, localhost) | No network auth. Daemon validates agent_id from MCP client metadata. Localhost-only binding with OS firewall rule. |
| REST (daemon ↔ cloud) | Long-lived refresh token in OS keychain (90-day rolling). Short-lived access token (1 hour), HMAC-signed JWT. Daemon refreshes silently. |
| WebSocket (daemon ↔ cloud realtime) | Same access token, attached at handshake. Server pushes `auth.expiring` 5min before expiry. |
| Trust app (user ↔ cloud, browser) | Magic link only. 30-day session cookie (HttpOnly, Secure, SameSite=Strict). Privileged actions require fresh re-auth (magic link sent again). |

### Versioning

URL-prefixed (`/v1/...`). Within v1: additive-only. Breaking changes ship as `/v2/` with 6-month overlap. MCP tool schemas carry `metadata.protocol_version`. Daemon and cloud handshake at startup; daemon downgrades to cloud's max version.

---

## Section 4 — Local Daemon (`klio-bridge`)

### Process model

**Go.** Single static binary, ~15MB, cross-compiles to macOS (Intel + Apple Silicon), Linux (x86_64 + arm64), Windows. Runs as **per-user background service** (launchd LaunchAgent / systemd user unit / Windows scheduled task). Never root.

### Two-process pattern: daemon + MCP shim

MCP is overwhelmingly stdio-based — agents spawn child processes and talk JSON-RPC over stdin/stdout. Solution:

```
Claude Code  ──spawns──►  klio-mcp (stdio shim) ──unix socket──┐
Cursor       ──spawns──►  klio-mcp (stdio shim) ──unix socket──┤
Codex        ──spawns──►  klio-mcp (stdio shim) ──unix socket──┤
                                                                ▼
                                                     klio-bridge (daemon)
                                                     • holds creds
                                                     • holds WebSocket
                                                     • holds cache
                                                     • does everything
```

Shim is ~200 lines of Go. Stateless. Daemon is one long-lived process per machine. All agents share the daemon's connection to the cloud, the cache, and the WebSocket.

### Bootstrap (`npx klio init`)

1. Detect platform, install daemon binary.
2. Generate machine UUID, store in keychain.
3. `POST /v1/users/provision { agent_kind: "klio-bridge", install_id }` → user_id + refresh token.
4. Stash refresh token in OS keychain.
5. Detect installed agents (Claude Code, Cursor, Codex).
6. Back up each agent's config (`<file>.klio-backup-<timestamp>`).
7. Edit each agent's config to add `mcpServers.klio` entry pointing at `klio-mcp`. For Claude Code: also register the six hooks.
8. Start daemon as background service.
9. Print summary; optionally open browser to klio.tech/welcome.

Total wall time: 5–8 seconds. Reversible: `klio uninstall` restores configs from backups.

### Config edit safety rules

1. Always back up first.
2. JSON-aware merging only.
3. Detect prior Klio entries; update in place rather than duplicating.
4. Never touch fields we didn't add.
5. Refuse to edit unparseable files; print diff and ask user to merge.
6. Verify after write; roll back on mismatch.

### Multi-agent serving

Daemon listens on unix domain socket at `~/.klio/bridge.sock` (TCP `localhost:7878` on Windows). Each shim connection gets a long-lived bidirectional pipe. Inside the daemon: shim listener → agent registry → cloud client + local cache + (optional) embedded engine in local-only mode.

### Real-time fan-out (cloud → daemon → MCP clients)

When a new entry hits a space:
1. Cloud `klio-realtime` publishes via Redis.
2. WebSocket frame to daemon.
3. Daemon writes to local cache, identifies relevant shims (active space match).
4. For each: emit MCP `notifications/resources/updated` over stdio.
5. Agents that handle it call `recall`. Agents that don't get the entry injected as context on next prompt.

Latency target: cloud-to-shim under 200ms P99 within region.

### Credential management

OS keychain: Keychain Services (macOS), libsecret (Linux), Credential Manager (Windows). Stored: refresh token (90-day rolling), machine install_id, encryption key id. Never on disk in plain.

Token refresh: automatic and silent. Refresh failure → daemon emits desktop notification, pauses sync, agents see graceful degradation.

### Local cache (SQLite, encrypted)

```
entries          -- last 30 days mirror, max 100MB; LRU eviction
write_queue      -- pending writes when offline
acl_cache        -- per-space permissions, refreshed every 5 min
session_state    -- last_acked_frame_id per space
agent_bindings   -- (cwd, agent_kind) → space_id
audit_local      -- daemon-internal action log
```

### Local-only mode

`klio mode local` flips a flag. WebSocket disconnects. Daemon switches to embedded `klio-engine` (same binary as cloud, sqlite-vec instead of pgvector). Extraction calls user's chosen LLM endpoint (default: existing env keys; or local Ollama). All data stays in `~/.klio/`. Reversible via `klio mode cloud`; existing local-only data doesn't sync up automatically (privacy default).

### Updates

Daemon checks `https://updates.klio.tech/manifest.json` every 6 hours. Manifest is signed (Ed25519 by Klio's signing key, public key embedded in binary). New binary fetched over TLS, signature verified, atomically swapped. Failed updates auto-roll back. `klio update off` opt-out.

### Observability

`klio status` (connection state, last sync, queue depth, active agents, errors). `klio diagnose` (self-check + opt-in anonymized telemetry). `klio logs` (tails `~/.klio/logs/bridge.log`, rotated daily, 7-day retention). Sentry crash reports opt-in.

### Cross-platform packaging (v0)

| Platform | Channel |
|---|---|
| All | `npx klio init` (canonical) |
| All (no Node) | `curl klio.tech/install.sh \| sh` (wraps npx) |

Native installers (signed `.pkg`, `.msi`, Homebrew, apt/yum) deferred to Phase 2 when funded. npm-fetched binaries side-step OS code-signing requirements (no Gatekeeper / SmartScreen prompts).

---

## Section 5 — Security Model (Tier 2)

### Threat model — STRIDE applied to agents-as-principals

| Threat | Substrate-specific instance | Mitigation |
|---|---|---|
| Spoofing | Hostile agent claims to be Claude Code | Per-agent API token, agent_id minted server-side, never trusted from client claim |
| Tampering | MITM rewrites entries | TLS 1.3 mandatory, certificate pinning in daemon, Ed25519 signature on every entry |
| Repudiation | User claims they didn't grant access | Audit log Merkle hash chain, hourly notarization, append-only |
| Information disclosure | Cross-tenant retrieval bug | Tenant-isolated vector indexes, double ACL check (coordinator + engine) |
| DoS | Anonymous account spam | Per-IP + per-fingerprint rate limit, anonymous quotas, exponential backoff |
| Elevation of privilege | `read` agent tries to `write` | ACL enforced inside engine query; `read` token can't reach `write` endpoint |

### Substrate-unique threats

| Threat | Mitigation |
|---|---|
| Memory poisoning (hostile entries prompt-inject future readers) | Entry-level provenance + author signature; trust-score by source; user-marked "untrusted" sources; agents see provenance metadata |
| Cross-agent exfiltration via space confusion | Write requires explicit space_id; trust app daily summary shows what was written |
| Provisioning abuse (bot creates millions of anon accounts) | Rate limit per IP/ASN/fingerprint, CAPTCHA on burst, anon quotas, 14-day inactive auto-delete |
| Daemon compromise (local malware exfiltrates refresh token) | Tokens scoped to install_id, rotation on every access-token mint, geolocation anomaly revocation, new-device notifications |
| Agent ACL escalation (compromised agent calls `request_access`) | User approval required (auto-prompt); admin scope requires fresh user re-auth |
| Subpoena / legal | Per-user envelope keys, key destruction on hard delete, quarterly transparency report, warrant canary on klio.tech |

### Five hard guarantees (marketing + VDP scope)

1. **No entry crosses spaces without an explicit grant.** Every read query carries `(user_id, agent_id, space_id)`. Engine validates the tuple before returning a row. Coordinator validates the same tuple before query is built. Two layers.
2. **No agent reads a space it doesn't have permission for.** Permission table is source of truth; engine re-checks on every query. Cache TTL 5min; revoked permissions take effect within that window worst-case.
3. **No data leaves the machine in local-only mode.** Outbound network policy enforced via `http.Transport` returning `not-allowed` on non-localhost dial. Telemetry, crash reports, update checks all gated. Verifiable via Wireshark/Little Snitch.
4. **Audit log is tamper-evident.** Merkle hash chain over privileged actions. Hourly root-hash notarization to OpenTimestamps. Anyone can verify the chain.
5. **User holds the off switch.** `klio uninstall --purge` triggers immediate hard delete: token revoked, entries soft-deleted with 0-day grace, S3 raw events purged within 24h, encryption keys destroyed (KMS deletion logged), audit log keeps tombstone.

### Encryption posture

```
At rest:
  Postgres data           AES-256-GCM, KMS-managed master keys
  S3 raw events           AES-256-GCM, per-user envelope keys
  Backups                 Encrypted with separate backup key, 90-day retention
  Local cache             AES-256-GCM, key from OS keychain
  Daemon credentials      OS keychain (Keychain Services / libsecret / Credential Manager)

In transit:
  Daemon ↔ cloud          TLS 1.3, mandatory, cipher allowlist, certificate pinning
  Trust app ↔ cloud       TLS 1.3, HSTS preload, secure cookies
  Magic link emails       DKIM + SPF + DMARC; link 15-min single-use
  WebSocket               wss:// only, never ws://

In use:
  Vector embeddings       Per-tenant index partitions; engine query carries tenant_id
  Extraction pipeline     Plaintext only in worker memory; encrypted before write
```

**No E2EE at v0.** Extraction, dedup, supersedes resolution, retrieval, and cross-agent intelligence require server-readable content. E2EE is incompatible with the substrate. Self-hosted (where the user owns keys) is the E2EE answer; stated explicitly on the security page.

### Authentication

- Magic link only for users; no passwords ever.
- API tokens for agents: 1-hour access + 90-day refresh. Refresh tokens device-bound.
- Privileged action re-auth: hard-delete account, rotate keys, grant admin — fresh magic link in last 5 min.
- No OAuth at v0 beyond Google + GitHub OIDC for B2B2C sign-in (week 4 post-launch, gated to verified domains).
- No SAML/SCIM at v0; lands with enterprise tier.

### Anti-abuse

```
Layer 1 — klio-edge (Cloudflare)
  DDoS protection, WAF managed + custom rules, Turnstile CAPTCHA on rate-limit breach

Layer 2 — coordinator
  Provisioning: 5 anon accounts/IP/hr, 50/ASN/hr
  Authenticated: 1000 reqs/min per user, burst 5000
  Anomaly detection: geolocation jump, write spike 10x baseline
  Anonymous account auto-purge: 7 days inactive → soft delete; 14 days → hard delete

Layer 3 — engine
  Query budget per (user, agent, hour)
  Memory quota: 1000 entries (anon), 100k entries (claimed free), more in paid tiers
```

### VDP at launch (replaces funded bug bounty)

- security.txt at `/.well-known/security.txt` (RFC 9116)
- security@klio.tech with PGP key
- Safe harbor for good-faith research within scope
- Response SLA: 24h triage, weekly status, fixed before public disclosure
- Hall of Fame public credit page
- Swag for valid findings ($40–60/shipment)
- Retroactive bounty commitment: "Critical and High findings during VDP phase will be retroactively rewarded once we close our seed round."
- Named substrate-specific scope: cross-tenant retrieval, ACL bypass, audit-log tamper, memory poisoning, daemon compromise

### Pre-launch private review

2–3 trusted security people, 2-week scope before launch. Compensation: equity grants or free Klio Pro for life + public credit. Documented in writing as a public artifact on klio.tech/security.

### Compliance posture

| Compliance | Status |
|---|---|
| GDPR | Day-one full compliance (right of access, erasure, portability, DPA template, EU residency option) |
| CCPA | Day-one (same surface satisfies; "Do Not Sell" link in footer) |
| HIPAA | Out of scope at v0; stated explicitly |
| SOC2 Type 1 | Process kicked off post-launch (week 11+), certified within 6 months when funded |
| SOC2 Type 2 | 12 months post-launch |

### OpSec

- All employee prod access via SSO + hardware key. No SSH passwords.
- No employee can decrypt user data alone — coordinator+engine code path, audit-logged.
- All deploys via signed CI artifacts. No human push to production.
- Secrets in HashiCorp Vault / cloud KMS. Never in env files in repos.
- Pre-commit gitleaks; CI re-runs.
- Dependabot + Snyk; Critical CVEs patched within 24h, High within 7d.

---

## Section 6 — Claude Code Integration

### What gets installed

```
~/.claude/
├── settings.json                       ← edited (mcpServers + hooks added)
├── plugins/
│   └── klio/
│       ├── plugin.json
│       ├── skills/
│       │   ├── klio-memory.md
│       │   ├── klio-collaborate.md
│       │   └── klio-spaces.md
│       └── commands/
│           ├── recall.md               ← /klio:recall <query>
│           ├── remember.md             ← /klio:remember <fact>
│           ├── space.md                ← /klio:space <name>
│           └── status.md               ← /klio:status
└── projects/                           ← read-only by us, used for backfill
```

### Six hooks

Each hook is a thin shell command piping JSON to `klio hook <name>`. Hooks return in <50ms; daemon does the work asynchronously.

| Hook | Daemon action | Effect on user |
|---|---|---|
| `SessionStart` | Resolve `(cwd, git_remote) → space_id`. Recall top-K relevant entries. Output `additionalContext` block. | Claude begins session knowing user's preferences, recent decisions, open TODOs. |
| `UserPromptSubmit` | Scan for trigger phrases (`remember`, `don't forget`, `from now on`, `note that`). Synchronous `remember` on hit. Always: append to per-session prompt buffer. | Explicit memory captured immediately; implicit captured on session end. |
| `PreToolUse` (Bash/Edit/Write only) | Quick recall for safety constraints. Print warning on hit. | Memory acts as a guardrail. |
| `PostToolUse` | Async-stream `(tool_name, args, result_summary)` to cache + write queue as `observation` entry. | Cross-agent visibility: Cursor sees in real time what Claude just did. |
| `SubagentStop` | Capture subagent's final report as `observation` (kind=`subagent_finding`). | Subagent context survives past parent session. |
| `Stop` | Submit full transcript to extraction pipeline. LLM extracts memories, plans, decisions, notes. | Every session permanently improves the next session. |

Hook payloads include agent_id, cwd, git_remote — daemon validates `(agent_id, space_id)` scope before any read or write.

### Klio skill (slash commands)

| Command | Action |
|---|---|
| `/klio:recall <query>` | `recall(query)` against active space, render results |
| `/klio:remember <fact>` | `remember(content)` in active space |
| `/klio:space [name]` | List spaces or switch active space |
| `/klio:status` | Show daemon state, active space, sync status |
| `/klio:grant <agent>` | Grant another agent access to active space (admin only) |

The skill markdown files describe trigger phrases so Claude proactively suggests memory operations without slash commands.

### Backfill — `klio backfill ~/.claude/projects`

The launch demo's killer feature.

1. Walk the directory tree. Each top-level dir = one project (path-encoded cwd).
2. Resolve to space_id. Auto-create per project; user confirms mapping before bulk import.
3. Stream each session file. Pre-filter: skip sessions older than 6 months; skip <N messages.
4. Batch through extraction with Haiku 4.5 (cheap, good enough). Provenance: `{source_type: "claude-code-session-backfill", session_id, original_timestamp, original_cwd}`.
5. Per-batch checkpointing. Resumable.
6. Final summary: counts of imported sessions, generated entries by kind.

**Cost estimate.** Heavy CC user has 500–2000 sessions in 6 months. ~5k tokens/session avg, Haiku batch pricing: $0.50–$3 per user. Free-tier absorbed; flag costs above $5 for explicit user approval.

### Workspace binding (cwd → space_id)

Daemon maintains a binding table:
```
agent_bindings (local SQLite):
  cwd_pattern        space_id          confirmed
  /Users/a/oppla/*   space_oppla_klio  true
  /Users/a/personal  space_personal    true
```

Resolution at SessionStart: exact match → pattern match → propose-and-prompt. Until user confirms, writes go to `Default`. Once confirmed, binding is saved.

Binding is a usability shortcut, not a security boundary. ACL still enforces space permissions at every read/write.

### The launch demo (60-second video)

```
$ npx klio init
✓ Daemon installed and running
✓ Anonymous Klio account created
✓ Claude Code configured: 6 hooks + Klio MCP server + skill
✓ Active space: Default

$ klio backfill ~/.claude/projects --confirm
Importing 318 sessions from 12 projects... [████] 100%
✓ Imported 318 sessions, generated 2,104 entries

$ cd ~/oppla/klio
$ claude
> what did we decide about the brand name?
Claude: You decided on "Klio" as the brand on 2026-05-02, with klio.tech…

[Open Cursor in same project]
> implement the daemon scaffold
Cursor: Following Claude's plan from earlier today: Go binary, gorilla/websocket…

[Back in Claude Code]
> what is Cursor doing?
Claude: Cursor edited internal/daemon/server.go 14 minutes ago — added the
unix socket listener and the per-shim goroutine pool.
```

### Failure modes

| Failure | Daemon behavior | User experience |
|---|---|---|
| Daemon not running | Shim returns MCP error gracefully | Agents lose Klio tools; desktop notification |
| Network out | Cache-only reads, queue writes | Recall hits cache (last 30 days); writes flush on reconnect |
| Auth expired | Pause sync, prompt re-auth | Magic link; sync resumes |
| Rate-limited | Exponential backoff | Writes queue; recall hits cache |
| Backfill fails mid-batch | Checkpointed | `klio backfill --resume` |
| Hook payload malformed | Log + discard | One observation lost |
| Cache corrupted | Detect on startup, rebuild from cloud | Brief slowdown |
| Cloud incident | Cache-only mode automatic | Read continues; writes queue |

**Principle: Klio degrades transparently.** No agent loses access to its tools when Klio has a problem.

---

## Section 7 — Launch Plan & Sequencing

### Capacity assumption

1 founder-engineer + 2 engineers + part-time contractor on trust app/marketing site. Plan compresses or stretches roughly linearly with capacity changes; sequencing is invariant.

### 10-week timeline

```
Week:        1     2     3     4     5     6     7     8     9     10
            ─────────────────────────────────────────────────────────
Track A     ████  ████  ████  ▒▒▒▒  ▒▒▒▒                           Engine + coordinator + realtime
Track B                 ████  ████  ████  ▒▒▒▒                     Daemon + CLI + MCP shim
Track C           ████  ████  ████  ▒▒▒▒                           Trust app + marketing site
Track D                       ████  ████  ████  ▒▒▒▒               Claude Code integration + backfill
Track E                                   ▓▓▓▓  ████  ████  ▒▒▒▒   Security hardening + VDP setup
Track F                                               ████  ████   Launch ops + private review
```

### Tracks

**Track A — Engine + coordinator + realtime (Weeks 1–5).** Schema design, identity model, ACL, plugin interface, REST endpoints, extraction pipeline, klio-realtime WebSocket fan-out, ACL enforcement at engine layer.

**Track B — Daemon + CLI + MCP shim (Weeks 3–6).** Go scaffold, unix socket server, agent registry, cloud client, token refresh, keychain integration. Seven MCP tools, local SQLite cache. `npx klio init` flow. Auto-discovery for Claude Code first; Cursor + Codex follow. Linux + Windows keychain. Local-only mode.

**Track C — Trust app + marketing site (Weeks 2–5).** Next.js scaffold, magic-link auth, four core pages (spaces list, space detail, audit log, export), hard delete with grace, account claim, signed JSON export. klio.tech marketing site with hero + demo video placeholder + how-it-works + security commitment + email capture.

**Track D — Claude Code integration + backfill (Weeks 4–7).** Six hooks, Klio plugin (skills + slash commands), trigger-phrase detection, workspace binding logic, backfill CLI. End-to-end test with 200+ sessions.

**Track E — Security hardening + VDP infra (Weeks 6–9).** Threat model document published. Tenant-isolated vector indexes verified with adversarial tests. Audit-log Merkle chain + hourly OpenTimestamps notarization. Rate limiting tuned. Cloudflare WAF deployed. VDP infra (security@klio.tech, PGP, Hall of Fame, security.txt). Pre-launch private review (3 trusted folks, 2 weeks).

**Track F — Launch ops + private review (Weeks 9–10).** Final QA, dogfood with 10 closed-beta users, status page, incident-response runbook, support inbox + Discord. Demo video shot/edited. Launch tweet thread, HN post, ProductHunt page, press kit.

### Gates (binary go/no-go)

| Gate | When | Criteria |
|---|---|---|
| **G1** | End of W3 | Engine + coordinator deployed on Railway. Schema migrated. Identity flow works. Recall/remember roundtrip via curl. |
| **G2** | End of W5 | `npx klio init` installs end-to-end on macOS + Linux. Recall/remember work in Claude Code. WebSocket holds. Cache survives daemon restart. |
| **G3** | End of W7 | Closed beta opens. 10 trusted users using daily. Backfill completes with 100+ historical sessions. Real-time cross-agent demo recorded successfully. |
| **G4** | End of W9 | Code freeze. Private security review complete with all Critical/High closed. Threat model published. VDP live. Status page operational. |
| **G5** | End of W10 | Public launch. Site up, video posted, HN submitted, demo verified by 5 fresh installs. |

A missed G3 is the canary — if cross-agent demo isn't working at end of W7, launch likely slips by 2 weeks.

### Launch week (W10)

```
Mon         Internal launch — full team, fresh installs, run demo end-to-end
Tue         Soft launch — email to 50 friendlies, collect feedback, fix P0s
Wed         Closed beta extended to ~200 via DMs to known builders
Thu         Final dress rehearsal; demo video locked; comms reviewed
Fri 6 AM PT Public launch — tweet thread, HN, ProductHunt, Discord opens
Fri-Sun     Hot launch window — engineering + support + comms on-call
```

### Risk register

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Backfill quality poor | Medium | High | Internal dogfood from W4. Tune extraction iteratively. `--preview` mode shows entries before save. |
| Real-time fan-out doesn't scale | Medium | High | Load test in W8. Redis Streams + connection pooling. Regional sharding sooner if needed. |
| MCP protocol breaking change upstream | Low | Medium | Pin SDK version. Follow upstream PRs. Migration playbook ready. |
| Cursor/Codex MCP support buggy | High | Low | CC is the launch story; others are bonus. Marketing emphasizes CC first. |
| Anon account abuse before limits tuned | Medium | High | Conservative limits at launch (5/IP/hr). CAPTCHA on burst. |
| Vex enterprise customers spooked | Medium | Medium | Pre-brief 2 weeks before. Position Klio as separate brand for different audience. |
| Big-lab memory announcement same week | Low | Medium | Counter-positioning ready: "neutral cross-agent layer is structurally different from any single-agent platform's memory." |
| LLM extraction cost overrun | Medium | Medium | Backfill cost preview + user approval above $5. Tier free quota carefully. Haiku 4.5 fallback. |
| Critical security finding late | Low | High | Tier 2 from W1 means most issues already addressed. Buffer week — slip W10 → W11 if needed. |

### Post-launch roadmap

```
Weeks 11–12   Tier 3 path: paid external pen test (if seed funded). Stabilization sprint.
Weeks 13–14   SOC2 Type 1 kickoff. Native installer track begins (signed .pkg, .msi, brew tap).
Weeks 13–18   Phase 1 expansion:
                • handoff verb (explicit @-addressed delivery)
                • threaded entries (parent_id / reply_to)
                • advanced cross-agent intelligence (closed plugin)
                • Cursor extension API integration (deeper than MCP)
Weeks 19–24   Phase 2 begins — first external connector (Slack, then Notion).
Month 6       SOC2 Type 1 audit complete. Multi-region live (EU-West, then AP-SE). Enterprise tier.
Month 12      SOC2 Type 2 complete.
```

### Explicitly out of scope for first 6 months

- SDK parity beyond TS + Python (Go, Rust, Java SDKs deferred)
- Mobile clients (web responsive only)
- Self-hosted enterprise installers beyond docker-compose
- Connector marketplace
- Memory federation across multiple Klio installs
- HIPAA / FedRAMP
- LLM-graded retrieval ranking

---

## Open items still to decide

These are not blockers for v0 but should be answered as the work progresses:

1. **Klio plugin marketplace listing.** Should the Claude Code plugin be submitted to Anthropic's plugin marketplace (when one exists), or distributed only through `npx klio init`?
2. **Anonymous account email policy.** Anonymous accounts created by agents — do we email the user the moment they're created (transparency) or only when claimed (less spam)? Lean toward immediate email.
3. **Cursor / Codex hook surfaces.** Today only Claude Code has a mature hook system. Track when Cursor and Codex add equivalent extension APIs and design analogous integrations.
4. **Pricing exact numbers.** Free tier limits (1000 anon entries, 100k claimed) are placeholders. Real numbers depend on actual extraction cost data from beta.
5. **B2B2C tier pricing.** Per-end-user pricing for embedded use case — not yet decided. Probably $0.10–$1.00/MAU range, but needs market testing.
6. **Trust app design language.** Visual identity for klio.tech and app.klio.tech — not yet designed. Likely needs a contractor.

---

## References

- [Strategic direction](../../2026-05-02-memory-product-direction-design.md) — why bifurcate, why MCP-first, why open core
- [Earlier MCP-server-only sketch](../../2026-05-02-memory-mcp-server-plan.md) — superseded by this document
- Klio brand reservation: [klio.tech](https://klio.tech), [github.com/klio-tech](https://github.com/klio-tech)
- Vex engine session-memory design: `vex_public/docs/plans/2026-03-08-session-memory-design.md` (referenced in strategic doc)
