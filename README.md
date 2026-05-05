<div align="center">

<a href="https://klio.tech">
  <img src="docs/klio-mark.svg" alt="Klio" width="64" height="64" />
</a>

# Klio

**The local-first, encrypted, MCP-native memory layer for AI agents.**

Your Claude Code, Claude Desktop, Cursor, Codex, OpenCode, and OpenClaw
sessions — finally remembering what you've decided, learned, and chosen,
across every window and every project.

[**klio.tech**](https://klio.tech) ·
[Quick start](#quick-start) ·
[How it works](#how-it-works) ·
[Why Klio](#why-klio) ·
[Discord](https://discord.gg/xRRPnW3fN2) ·
[Cloud (waitlist)](https://klio.tech/cloud)

<!-- Live status badges. The CI ones pull workflow state from
     GitHub Actions automatically; npm pulls from the registry. The
     license + MCP-native badges are static (they don't change). -->
[![Publish container images](https://github.com/klio-tech/klio/actions/workflows/release-images.yml/badge.svg?branch=main)](https://github.com/klio-tech/klio/actions/workflows/release-images.yml)
[![Publish to npm](https://github.com/klio-tech/klio/actions/workflows/publish-npm.yml/badge.svg?branch=main)](https://github.com/klio-tech/klio/actions/workflows/publish-npm.yml)
[![npm version](https://img.shields.io/npm/v/%40klio-tech%2Fklio?label=npm)](https://www.npmjs.com/package/@klio-tech/klio)
[![Discord](https://img.shields.io/badge/discord-join-7289DA?logo=discord&logoColor=white)](https://discord.gg/xRRPnW3fN2)
[![GitHub stars](https://img.shields.io/github/stars/klio-tech/klio?style=social)](https://github.com/klio-tech/klio)

[![License: AGPL-3.0](https://img.shields.io/badge/Engine-AGPL--3.0-blue.svg)](LICENSE)
[![MCP Shim: Apache-2.0](https://img.shields.io/badge/MCP%20Shim-Apache--2.0-green.svg)](LICENSE-APACHE-2.0)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-native-purple)](https://modelcontextprotocol.io)

```
npx @klio-tech/klio init
```

**[★ Star Klio on GitHub](https://github.com/klio-tech/klio)** if memory-that-survives-the-window-close sounds like a primitive every AI agent should have.

</div>

---

## What Klio is

Most AI coding agents — Claude Code, Claude Desktop, Cursor, Codex,
OpenCode, OpenClaw — start every session from zero. They don't
remember that you prefer Bun over Node, that you chose Railway over
Fly, or that the bug you spent two hours on yesterday turned out to be
a stale cache. The agent re-asks. You re-explain. The context
evaporates the moment you close the window.

**Klio fixes that.** It's a local memory daemon that captures every
prompt and tool call from your AI agents, extracts the durable facts,
embeds them with a vector model, and serves them back as MCP tools so
*any* MCP-aware agent can recall them. Same memory store, different
agents, across sessions, across projects.

```
┌──────────────┐  ┌──────────────┐  ┌────────┐  ┌───────┐  ┌──────────┐  ┌──────────┐
│ Claude Code  │  │ Claude Desktop│ │ Cursor │  │ Codex │  │ OpenCode │  │ OpenClaw │
└──────┬───────┘  └───────┬──────┘  └───┬────┘  └───┬───┘  └────┬─────┘  └────┬─────┘
       │ MCP stdio        │ MCP stdio  │ MCP stdio │ MCP stdio │ MCP stdio   │ MCP stdio
       └──────────────────┴────────────┴─────┬─────┴───────────┴─────────────┘
                                             ▼
                          ┌──────────────────────────┐
                          │   klio-bridge container  │ ◄── packages both:
                          │   (Go)                   │     • daemon (HTTP + Unix socket)
                          │                          │     • klio-mcp (stdio shim)
                          └──────────────┬───────────┘
                                         │
                          ┌──────────────▼───────────┐
                          │       klio-engine        │ ◄── per-space pluggable
                          │ (Python, FastAPI)        │     embeddings
                          │ Postgres + pgvector      │     OpenTimestamps
                          │ Redis pub/sub            │     notarized
                          │ Local file KMS (~/.klio) │     AES-256-GCM at rest
                          └──────────────────────────┘
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

One command — `npx @klio-tech/klio init` — does the entire setup:

1. **Pulls four containers** (engine, bridge, dashboard, plus Postgres
   + Redis), boots them locally, runs migrations.
2. **Walks you through provider + model picks** (OpenRouter, Ollama,
   or any OpenAI-compatible endpoint) and validates your choice with a
   one-token probe before continuing.
3. **Detects every supported AI agent on your machine** and patches
   each one's MCP config so they all point at the same shared bridge:
   - Claude Code (`~/.claude/settings.json` + 6 hooks + tool allowlist)
   - Claude Desktop — Chat **and** Cowork
     (`~/Library/Application Support/Claude/claude_desktop_config.json`)
   - Cursor (`~/.cursor/mcp.json`)
   - Codex (`~/.codex/config.toml`)
   - OpenCode (`~/.config/opencode/opencode.json`)
   - OpenClaw (`openclaw mcp set` CLI, with file-write fallback)
4. **Asks you to type one memory** so the loop is provably wired —
   the CLI confirms recall before exiting.
5. **Provisions an anonymous account**; claim it later via email if
   you want to sync to Klio Cloud.

Each adapter writes a timestamped backup of the file it modifies, so
`npx @klio-tech/klio uninstall` is non-destructive — it restores the
exact pre-Klio state for every agent.

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

| Model                                          | Dim  | Disk     | License     |
|------------------------------------------------|------|----------|-------------|
| `ollama/nomic-embed-text` *(default)*          | 768  | 274 MB   | Apache 2.0  |
| `ollama/mxbai-embed-large`                     | 1024 | 670 MB   | Apache 2.0  |
| `ollama/snowflake-arctic-embed2`               | 1024 | ~1.2 GB  | Apache 2.0  |
| `ollama/bge-m3`                                | 1024 | ~2.2 GB  | MIT         |
| `openrouter/openai/text-embedding-3-small`     | 1536 | -        | proprietary |
| `openrouter/voyage/voyage-3`                   | 1024 | -        | proprietary |
| `openrouter/cohere/embed-multilingual-v3.0`    | 1024 | -        | proprietary |

(Bare-OpenAI rows were dropped in 0.3.0 alongside the LiteLLM removal;
all hosted-model traffic now flows through OpenRouter so a single API
key covers every provider.)

Switch a space's model at any time without re-architecting:

```bash
docker exec -i klio-bridge klio reembed \
  --space default --to ollama/snowflake-arctic-embed2
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
- Node 20+ (`node --version`) — needed only for the launcher (`npx`)
- ~8 GB free disk
- *(macOS)* If you pick the Ollama provider: a working `ollama`
  install (Metal acceleration). On Linux, the docker-compose
  `docker-ollama` profile is used as a CPU fallback.

```bash
npx @klio-tech/klio init
```

That's it. The launcher pulls four containers (engine, bridge,
dashboard, plus Postgres + Redis), boots them, runs migrations, walks
you through provider + model selection, detects every supported AI
agent on your machine, and patches each one's MCP config. ~30 seconds
on a warm Docker, ~2 min on a cold first run.

The five interactive phases:

| Phase                     | What happens                                                       |
|---------------------------|--------------------------------------------------------------------|
| 1. Stack boot             | `docker compose pull` + `up -d` for engine, bridge, dashboard, db. |
| 2. Provider pick          | OpenRouter (recommended), Ollama (fully local), or custom OpenAI-compatible. |
| 3. Model probe            | One-token test request validates the key + model before committing. |
| 4. Agent wiring           | All six adapters detect → backup → patch each agent's MCP config.   |
| 5. Wow moment             | You type one memory, the CLI proves recall before exiting.          |

Open any patched agent (Claude Code, Claude Desktop, Cursor, Codex,
OpenCode, OpenClaw) and ask:
*"Use Klio's recall tool to find what I prefer for JavaScript runtime."*

It'll find what you write going forward and any prior memories you've
added. The Claude Code hooks silently capture every prompt and tool
call, and Redis pub/sub fans those memories out to every other agent
in real time.

The trust-app dashboard is served at <http://127.0.0.1:3000> the
moment the stack is up.

To uninstall fully:

```bash
npx @klio-tech/klio uninstall
```

This walks the same six adapters in reverse, restoring the timestamped
backup each one wrote at install time — your agent configs return to
their pre-Klio state byte-for-byte.

To stop the stack without uninstalling: `docker compose down`.

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

Every agent gets the seven MCP tools. Claude Code *also* gets six
event hooks so memory capture happens silently — no prompt-engineering,
no "did you mean to remember this?" loop. The other five agents
(Claude Desktop, Cursor, Codex, OpenCode, OpenClaw) capture via tool
calls today; their hook equivalents will land as each platform
exposes a stable hook surface.

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
trust-app (Next.js, container)  ◄─────►  engine (FastAPI, container)
  /memories                                ├── /v1/spaces
  /spaces                                  ├── /v1/spaces/{id}/entries
  /access-requests                         ├── /v1/spaces/{id}/recall
  /security                                ├── /v1/spaces/{id}/reembed
                                           ├── /v1/auth/login-link
                                           ├── /v1/audit
                                           └── ...

klio-bridge (Go, container)              ── packages two binaries:
  ├── klio-mcp   ◄─ MCP stdio shim         (consumed by every agent
  │                                          via `docker exec -i`)
  └── klio-daemon                          (long-running)
        ├── unix socket
        ├── SQLite cache
        ├── keychain backend
        └── Redis subscriber

bridge daemon              ◄─────────►  engine + Redis
                                           publishes + receives frames

Postgres + pgvector                       entries (encrypted)
                                          entry_embeddings_768/1024/1536
                                          audit_log (hash-chained)
                                          spaces (per-space embedding pin)
                                          users (envelope-key-wrapped)
                                          agents, permissions, access_requests
                                          audit_notarizations (OpenTimestamps proofs)

Ollama (native or docker)                nomic-embed-text + qwen2.5:7b-instruct

@klio-tech/klio (npm)                    user-facing launcher: pulls
                                          containers, picks provider,
                                          patches every agent's MCP config
```

For deep architecture: [docs/plans/2026-05-02-klio-architecture-design.md](docs/plans/2026-05-02-klio-architecture-design.md).

---

## How Klio compares

| Feature                              | **Klio**                | mem0           | Zep             | Supermemory     |
|--------------------------------------|-------------------------|----------------|-----------------|-----------------|
| Open source                          | ✅ AGPL v3 + Apache 2.0  | ✅             | ✅              | ❌ proprietary  |
| Self-hosted by default               | ✅                      | ✅             | ✅              | ❌ cloud-only   |
| Encrypted at rest with user-owned key| ✅ AES-256-GCM + KMS     | ❌             | ❌              | ❌              |
| Cryptographic audit chain            | ✅ + OpenTimestamps      | ❌             | ❌              | ❌              |
| MCP-native (drops into agents)       | ✅ 7 tools, 6 adapters   | ❌ SDK only    | ❌ SDK only     | ❌ SDK only     |
| Real-time cross-agent pub/sub        | ✅ Redis                 | ❌             | partial         | ❌              |
| Per-space embedding model            | ✅ 7 models, runtime-switchable | one global | one global  | opaque          |
| Local UI                             | ✅ Next.js dashboard     | ❌             | ✅ web          | ✅ web          |
| Anonymous-first onboarding           | ✅                      | account up-front | account up-front | account up-front |
| One-command setup                    | ✅ `npx @klio-tech/klio init` | npm install + config | docker run + config | hosted only |

Klio's bet: trust + protocol-native > connectors + polish (for now).

---

## Repository layout

```
klio/
├── README.md                  # this file
├── LICENSE                    # AGPL v3 (engine + everything not Apache-licensed)
├── LICENSE-APACHE-2.0         # Apache 2.0 — covers the MCP shim + claude-plugin
├── LICENSING.md               # open-core boundary
├── HANDOFF.md                 # exhaustive run-recipe + state of every component
├── Makefile                   # contributor convenience targets (engine dev, lint, etc.)
├── docker-compose.yml         # Postgres + Redis + Ollama + trust-app + bridge
├── .env.example               # template for trust-app docker auto-login
├── docs/
│   ├── klio-mark.svg          # canonical wordmark (matches KlioMark.tsx)
│   ├── embedding-models.md    # how the per-space pluggable embeddings work
│   ├── plans/                 # architecture + implementation plans
│   └── security/              # threat-model + triage-runbook
├── engine/                    # Python 3.12 / FastAPI / SQLAlchemy / pgvector
│   ├── pyproject.toml
│   ├── alembic/               # migrations
│   └── src/klio_engine/       # api/, audit/, auth/, crypto/, models/, services/
├── bridge/                    # Go 1.22 / daemon + CLI + MCP shim (one container)
│   ├── go.mod
│   ├── cmd/                   # klio-daemon, klio-mcp, klio CLI
│   └── internal/              # agentadapters/, backfill/, bootstrap/, cache/, cloud/,
│                              # config/, daemon/, hooks/, keychain/, mcp/, realtime/, socket/
├── npm/                       # @klio-tech/klio — user-facing launcher (TypeScript)
│   ├── package.json
│   ├── src/                   # commands/init, commands/uninstall, providerSetup,
│   │                          # adapters/{claudeCode,claudeDesktop,cursor,codex,
│   │                          #          openCode,openClaw}.ts
│   └── tests/                 # vitest — ~190 hermetic unit tests
├── claude-plugin/             # Claude Code plugin manifest + 3 skills + 4 slash commands
├── trust-app/                 # Next.js 16 / TypeScript / React 19 — landing + dashboard
│   └── src/app/(local)/       # local dashboard (memories, spaces, security)
│       src/app/(public)/      # klio.tech marketing site
└── infra/                     # SQL init scripts; Terraform deferred
```

---

## Status

Klio is at **v0** — every engineering surface listed in this README is
implemented and tested locally on the author's machine, but the
project has not yet had a wider security review or external production
deployment.

| Component                  | State                                       |
|----------------------------|---------------------------------------------|
| Engine (FastAPI)           | ✅ 130 tests passing                         |
| Bridge daemon (Go)         | ✅ 14 packages, all tests passing            |
| Trust-app (landing + dash) | ✅ typecheck + dual-target build green       |
| `@klio-tech/klio` (npm)    | ✅ published; ~190 tests passing             |
| Claude Code adapter        | ✅ live in author's daily use                |
| Claude Desktop adapter     | ✅ Chat + Cowork variants                    |
| Cursor adapter             | ✅ shipped                                   |
| Codex adapter              | ✅ shipped (TOML config)                     |
| OpenCode adapter           | ✅ shipped (0.4.1)                           |
| OpenClaw adapter           | ✅ shipped (0.4.1, CLI-first)                |
| Real-time pub/sub          | ✅ verified end-to-end                       |
| OpenTimestamps notarize    | ✅ hourly cron + stub fallback               |
| Pluggable embeddings       | ✅ 7 models supported, runtime-switch        |
| Encrypted-at-rest          | ✅ AES-256-GCM + persistent local KMS        |
| Audit hash chain           | ✅ tamper-evident                            |
| GitHub Actions CI          | ✅ engine + npm + container images           |
| Klio Cloud (multi-tenant)  | ❌ private repo, planned                     |

---

## Roadmap

**v0.x — pre-launch (current)**

- Audit-chain visualizer in the trust-app
- `klio backfill` UX polish (progress bars, resume tokens)
- Windows-native adapter paths (today the adapters assume macOS / Linux
  XDG conventions; Windows users run via WSL2)
- Per-project space auto-routing (cwd → space)

**v1.0 — public launch**

- PyPI `klio-engine` package (the engine as a library, not just a container)
- Signed releases (Sigstore / Cosign)
- Klio Cloud beta (waitlist at https://klio.tech/cloud)
- Pre-launch external security review

**v1.x — cross-agent intelligence**

- Cross-agent conflict resolution (when two agents write contradicting facts)
- Premium connectors: Salesforce, Notion, Linear, Slack, Gmail
- Hosted enterprise SSO + RBAC
- Audit-chain attestation export (proof bundle for compliance teams)

---

## Author

**Abhishek Singh** ·
[@7hakurg](https://github.com/7hakurg) ·
contact@klio.tech

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
- [OpenRouter](https://openrouter.ai) — single-API-key access to every hosted provider
- [Model Context Protocol](https://modelcontextprotocol.io) — Anthropic's open spec for agent tools
- [OpenTimestamps](https://opentimestamps.org) — Bitcoin-anchored proof of existence
- [FastAPI](https://fastapi.tiangolo.com) · [SQLAlchemy](https://www.sqlalchemy.org) · [Alembic](https://alembic.sqlalchemy.org) — Python web + data stack
- [Next.js](https://nextjs.org) — the trust-app dashboard and klio.tech
