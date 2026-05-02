<div align="center">

# Klio

**The local-first, encrypted, MCP-native memory layer for AI agents.**

Your Claude Code, Cursor, and Codex sessions — finally remembering what
you've decided, learned, and chosen, across every window and every project.

[**klio.tech**](https://klio.tech) ·
[Quick start](#quick-start) ·
[How it works](#how-it-works) ·
[Why Klio](#why-klio) ·
[Roadmap](#roadmap) ·
[Cloud (waitlist)](https://klio.tech/cloud)

[![License: AGPL-3.0](https://img.shields.io/badge/Engine-AGPL--3.0-blue.svg)](LICENSE)
[![MCP Shim: Apache-2.0](https://img.shields.io/badge/MCP%20Shim-Apache--2.0-green.svg)](LICENSE-APACHE-2.0)
[![Engine tests](https://img.shields.io/badge/engine%20tests-103%20passing-brightgreen)](engine/tests)
[![Bridge tests](https://img.shields.io/badge/bridge%20tests-13%20packages%20passing-brightgreen)](bridge)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-native-purple)](https://modelcontextprotocol.io)

</div>

---

## What Klio is

Most AI coding agents — Claude Code, Cursor, Codex — start every session
from zero. They don't remember that you prefer Bun over Node, that you
chose Railway over Fly, or that the bug you spent two hours on yesterday
turned out to be a stale cache. The agent re-asks. You re-explain. The
context evaporates the moment you close the window.

**Klio fixes that.** It's a local memory daemon that captures every
prompt and tool call from your AI agents, extracts the durable facts,
embeds them with a vector model, and serves them back as MCP tools so
*any* MCP-aware agent can recall them. Same memory store, different
agents, across sessions, across projects.

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│   Claude Code   │         │     Cursor      │         │      Codex      │
└────────┬────────┘         └────────┬────────┘         └────────┬────────┘
         │ MCP tools + hooks         │ MCP tools                 │ MCP tools
         └───────────────────────────┼───────────────────────────┘
                                     ▼
                          ┌──────────────────────┐
                          │   Klio bridge daemon │ ◄── encrypted-at-rest
                          │   (Go, Unix socket)  │     audit-chained
                          └──────────┬───────────┘     ~/.klio
                                     │
                          ┌──────────▼───────────┐
                          │     Klio engine      │ ◄── per-space pluggable
                          │ (Python, FastAPI)    │     embeddings
                          │ Postgres + pgvector  │     OpenTimestamps
                          │ Redis pub/sub        │     notarized
                          │ Local file KMS       │
                          └──────────────────────┘
```

Everything runs on your machine. Your memories never leave it unless you
ship them somewhere yourself.

---

## Why Klio

### Local-first — your data stays on your laptop

Postgres, Redis, and your embeddings all live in Docker on your machine.
The encrypted entries are sealed under an AES-256 envelope key that's
itself wrapped by a master key in `~/.klio/dev-kms.key` (mode `0600`,
owned by you). No cloud, no telemetry, no phone-home, no analytics.

### MCP-native — works with every agent that speaks the protocol

One `klio init` command:

1. Registers Klio as an MCP server in your Claude Code config (via the
   official `claude mcp add-json` CLI)
2. Patches six event hooks (`SessionStart`, `UserPromptSubmit`,
   `PreToolUse`, `PostToolUse`, `SubagentStop`, `Stop`) so Klio
   silently captures activity without any prompting
3. Auto-allowlists all seven Klio tools in `permissions.allow` so
   first-run users don't see "Do you want to proceed?" prompts
4. Writes a docker-compose `.env` so the trust-app dashboard auto-logs
   in — no magic-link round-trip on your own machine
5. Provisions an anonymous account; claim it later via email if you
   want to sync to Klio Cloud

Cursor + Codex adapters land next.

### Cross-agent collaboration in real time

Every entry write publishes to Redis on `space:<space_id>`. A Cursor
instance can subscribe and receive frames within milliseconds —
literally see what Claude Code is doing as it happens. The protocol
contract is stable: `{type, space_id, frame_id, entry: {...}}`.

### Cryptographically auditable

Every action is appended to an immutable hash chain
(SHA-256 over the prior row's hash + this row's content). Every hour,
the global root is submitted to OpenTimestamps for blockchain-anchored
notarization. You can prove your audit log wasn't tampered with — even
to a third-party auditor with no trust in Klio.

### Pluggable embeddings, switchable per space

Each space pins its own embedding model and dim. Out of the box:

| Model                                | Dim  | Disk     | License     |
|--------------------------------------|------|----------|-------------|
| `ollama/nomic-embed-text` *(default)* | 768  | 274 MB   | Apache 2.0  |
| `ollama/mxbai-embed-large`            | 1024 | 670 MB   | Apache 2.0  |
| `ollama/snowflake-arctic-embed2`      | 1024 | ~1.2 GB  | Apache 2.0  |
| `ollama/bge-m3`                       | 1024 | ~2.2 GB  | MIT         |
| `text-embedding-3-small` (OpenAI)     | 1536 | -        | proprietary |

Switch a space's model at any time without re-architecting:

```bash
klio reembed --space default --to ollama/snowflake-arctic-embed2
```

The shadow-table architecture means new models are a one-migration add,
not a re-architecture. See [docs/embedding-models.md](docs/embedding-models.md).

### Open core, transparently

Apache 2.0. The engine, bridge daemon, MCP shim, trust-app, and CLI are
all open source. The upcoming **Klio Cloud** adds team-scoped spaces,
cross-agent intelligence, premium connectors (Salesforce, Notion,
Linear), and managed multi-region storage — none of which gate basic
local self-hosted use. See [LICENSING.md](LICENSING.md) for the
boundary.

---

## Quick start

Prerequisites:

- Docker Desktop running (`docker info`)
- Python 3.12+ (`python3 --version`)
- Go 1.22+ (`go version`)
- Node 20+ (`node --version`)
- Homebrew on macOS (for native Ollama with Metal acceleration); on
  Linux, the docker-compose `docker-ollama` profile is used as a
  CPU fallback.
- ~8 GB free disk

```bash
# 1. Clone + provision dependencies
git clone https://github.com/klio-tech/klio.git
cd klio
make first-run            # docker + ollama + migrate + build /tmp/klio + /tmp/klio-mcp

# 2. Start the engine in one terminal
make engine

# 3. In a second terminal: provision your account + wire Claude Code
KLIO_USE_FILE_KEYCHAIN=1 KLIO_API_URL=http://127.0.0.1:8000 \
  /tmp/klio init

# 4. Start the bridge daemon in the background
KLIO_USE_FILE_KEYCHAIN=1 KLIO_API_URL=http://127.0.0.1:8000 \
  /tmp/klio daemon &

# 5. Bring up the memories dashboard
docker compose up -d trust-app

# 6. Open it
open http://127.0.0.1:3000

# 7. Restart Claude Code so it picks up the new MCP server + hooks
```

Now in a fresh Claude Code session, ask:
*"Use Klio's recall tool to find what I prefer for JavaScript runtime."*

It'll find what you write going forward and any prior memories you've
added. Hooks silently capture every prompt and tool call.

To stop everything: `docker compose down && pkill -f /tmp/klio`.
To uninstall fully: `KLIO_USE_FILE_KEYCHAIN=1 /tmp/klio uninstall`
(restores `~/.claude/settings.json` from the backup created at install).

---

## How it works

### The seven MCP tools

| Tool        | What it does                                                 |
|-------------|--------------------------------------------------------------|
| `recall`    | Semantic search over your memories. The most-used tool.       |
| `remember`  | Store a stable preference / fact about you.                   |
| `observe`   | Log something the agent did or saw. Used by hooks.            |
| `plan`      | Post a forward-looking intent another agent can pick up.       |
| `decide`    | Record a chosen path with rationale.                          |
| `note`      | Free-form annotation when the others don't fit.                |
| `space`     | Manage spaces (`list`, `switch`, `info`, `request_access`).    |

### The six Claude Code hooks

| Event              | What Klio captures                                          |
|--------------------|-------------------------------------------------------------|
| `SessionStart`     | Marks a session boundary, attaches subsequent activity.      |
| `UserPromptSubmit` | Detects trigger phrases like "remember that…" or "I prefer". |
| `PreToolUse`       | Recalls relevant memories *before* Bash/Edit/Write runs.     |
| `PostToolUse`      | Logs every tool call as an `observation`.                    |
| `SubagentStop`     | Collects the subagent's final output for cross-agent recall. |
| `Stop`             | Marks session end, flushes anything still in flight.          |

### Architecture at a glance

```
trust-app (Next.js)        ◄─────────►  engine
  /memories                                ├── /v1/spaces
  /spaces                                  ├── /v1/spaces/{id}/entries
  /access-requests                         ├── /v1/spaces/{id}/recall
  /security                                ├── /v1/spaces/{id}/reembed
                                           ├── /v1/auth/login-link
                                           ├── /v1/audit
                                           └── ...

klio-mcp (Go, stdio MCP)   ◄─────────►  bridge daemon
                                          ├── unix socket
                                          ├── SQLite cache
                                          ├── keychain backend
                                          └── Redis subscriber

bridge daemon              ◄─────────►  engine + Redis
                                           publishes + receives frames

Postgres                                 entries (encrypted)
   + pgvector                            entry_embeddings_768/1024/1536
                                         audit_log (hash-chained)
                                         spaces (per-space embedding pin)
                                         users (envelope-key-wrapped)
                                         agents, permissions, access_requests
                                         audit_notarizations (OpenTimestamps proofs)

Ollama (native or docker)               nomic-embed-text + qwen2.5:7b-instruct
```

For deep architecture: [docs/plans/2026-05-02-klio-architecture-design.md](docs/plans/2026-05-02-klio-architecture-design.md).

---

## How Klio compares

| Feature                              | **Klio** | mem0      | Zep       | Supermemory |
|--------------------------------------|----------|-----------|-----------|-------------|
| Open source                          | ✅ Apache 2.0 | ✅       | ✅       | ❌ proprietary |
| Self-hosted by default               | ✅       | ✅        | ✅        | ❌ cloud-only  |
| Encrypted at rest with user-owned key| ✅ AES-256-GCM + KMS | ❌ | ❌ | ❌            |
| Cryptographic audit chain            | ✅ + OpenTimestamps  | ❌ | ❌ | ❌            |
| MCP-native (drops into agents)       | ✅ 7 tools          | ❌ SDK only | ❌ SDK only | ❌ SDK only |
| Real-time cross-agent pub/sub        | ✅ Redis            | ❌  | partial | ❌            |
| Per-space embedding model            | ✅ 5 models, runtime-switchable | one global | one global | opaque |
| Local UI                             | ✅ Next.js dashboard | ❌  | ✅ web | ✅ web         |
| Anonymous-first onboarding           | ✅                  | account up-front | account up-front | account up-front |

Klio's bet: trust + protocol-native > connectors + polish (for now).

---

## Repository layout

```
klio/
├── README.md                  # this file
├── LICENSE                    # Apache 2.0
├── LICENSING.md               # open-core boundary
├── HANDOFF.md                 # exhaustive run-recipe + state of every component
├── Makefile                   # `make first-run` is the one-shot setup
├── docker-compose.yml         # Postgres + Redis + (opt) Ollama + trust-app
├── .env.example               # template for trust-app docker auto-login
├── docs/
│   ├── embedding-models.md    # how the per-space pluggable embeddings work
│   ├── plans/                 # architecture + implementation plans
│   └── security/              # threat-model + triage-runbook
├── engine/                    # Python 3.12 / FastAPI / SQLAlchemy / pgvector
│   ├── pyproject.toml
│   ├── alembic/               # migrations (5 of them)
│   └── src/klio_engine/       # api/, audit/, auth/, crypto/, models/, services/
├── bridge/                    # Go 1.22 / daemon + CLI + MCP shim
│   ├── go.mod
│   └── internal/              # agentadapters/, backfill/, bootstrap/, cache/, cloud/,
│                              # config/, daemon/, hooks/, keychain/, mcp/, realtime/, socket/
├── claude-plugin/             # Claude Code plugin manifest + 3 skills + 4 slash commands
├── trust-app/                 # Next.js 15 / TypeScript / React 19 — local dashboard
└── infra/                     # SQL init scripts; Terraform deferred
```

---

## Status

Klio is at **v0** — every engineering surface listed in this README is
implemented and tested locally on the author's machine, but the
project has not yet had a wider security review or external production
deployment.

| Component                | State                                  |
|--------------------------|----------------------------------------|
| Engine (FastAPI)         | ✅ 103 tests passing                    |
| Bridge daemon (Go)       | ✅ 13 packages, all tests passing       |
| Trust-app dashboard      | ✅ typecheck + production build green   |
| Claude Code adapter      | ✅ live in author's daily use           |
| Cursor adapter           | ❌ designed, not built                  |
| Codex adapter            | ❌ designed, not built                  |
| Real-time pub/sub        | ✅ verified end-to-end                  |
| OpenTimestamps notarize  | ✅ hourly cron + stub fallback          |
| Pluggable embeddings     | ✅ 5 models supported, runtime-switch   |
| Encrypted-at-rest        | ✅ AES-256-GCM + persistent local KMS   |
| Audit hash chain         | ✅ tamper-evident                       |
| Klio Cloud (multi-tenant)| ❌ private repo, planned                |

---

## Roadmap

**v0.x — pre-launch (current)**

- Cursor adapter (`agentadapters/cursor.go`)
- Codex / OpenAI Apps adapter
- Audit-chain visualizer in the trust-app
- `klio backfill` UX polish (progress bars, resume tokens)
- CI on GitHub Actions (engine pytest + bridge `go test ./...` + trust-app `next build`)

**v1.0 — public launch**

- npm `@klio/cli` package wrapping the Go binaries via `npx klio init`
- PyPI `klio-engine` package
- Signed releases (Sigstore / Cosign)
- Klio Cloud beta (waitlist at https://klio.tech/cloud)
- Pre-launch private security review

**v1.x — cross-agent intelligence**

- Cross-agent conflict resolution (when two agents write contradicting facts)
- Per-project space auto-routing (cwd → space)
- Premium connectors: Salesforce, Notion, Linear, Slack, Gmail
- Hosted enterprise SSO + RBAC

---

## Author

**Abhishek Singh** ·
[@7hakurg](https://github.com/7hakurg) ·
contact@klio.tech ·
[oppla.ai](https://oppla.ai)

Klio is a separate brand from [Vex](https://tryvex.dev) — the author's
enterprise reliability product. Klio is consumer + B2B2C OSS; Vex is
enterprise SaaS.

---

## License

Klio is **split-licensed** by component:

- **The MCP shim** (`bridge/cmd/klio-mcp/`) and the **Claude Code plugin**
  (`claude-plugin/`) are [Apache 2.0](LICENSE-APACHE-2.0). These pieces are
  meant to be embedded inside agent tools (Claude Code, Cursor, Codex, etc.),
  so they're permissive — you can ship them inside a closed-source product
  without copyleft entanglement.
- **Everything else** (the engine, the daemon, the trust-app dashboard,
  internal packages, docs) is [AGPL v3](LICENSE). You can self-host, fork,
  and modify freely. **If you offer a modified version as a hosted service
  to other people, you must release your modified source under AGPL too** —
  this is the SaaS protection clause.

This split lets the protocol layer be embedded everywhere while protecting
the engine from rent-seeking cloud forks.

For commercial licensing of the AGPL components (e.g., to embed Klio's
engine in a closed-source product), email contact@klio.tech.

The future **Klio Cloud** (hosted, multi-tenant) is a separate proprietary
product on top of the same AGPL engine — see [LICENSING.md](LICENSING.md)
for the full breakdown of all three tiers (Apache shim, AGPL engine,
proprietary Cloud).

## Contributing

PRs welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow,
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for behavioural expectations,
and [SECURITY.md](SECURITY.md) for responsible-disclosure of
vulnerabilities (please don't file security issues in GitHub Issues).

## Acknowledgements

Klio stands on the shoulders of:

- [pgvector](https://github.com/pgvector/pgvector) — the vector index
- [Ollama](https://ollama.com) — local model serving
- [LiteLLM](https://github.com/BerriAI/litellm) — provider abstraction
- [Model Context Protocol](https://modelcontextprotocol.io) — Anthropic's open spec for agent tools
- [OpenTimestamps](https://opentimestamps.org) — Bitcoin-anchored proof of existence
