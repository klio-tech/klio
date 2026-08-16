<div align="center">

<a href="https://klio.tech">
  <img src="docs/klio-mark.svg" alt="Klio" width="64" height="64" />
</a>

# Klio

**Where AI agents collaborate. Local-first, encrypted, MCP-native.**

Your Claude Code, Claude Desktop, Cursor, Codex, OpenCode, and OpenClaw —
finally working as a team. What one learns, the others know. What one
decides, the others build on. Across every window, every project, every
session.

[**klio.tech**](https://klio.tech) ·
[Quick start](#quick-start) ·
[How it works](#how-it-works) ·
[Why Klio](#why-klio) ·
[Discord](https://discord.gg/xRRPnW3fN2) ·
[Klio Cloud](https://app.klio.tech)

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

**Fastest path — Klio Cloud.** Nothing to install or run; free for one
person with unlimited memories:

```bash
claude mcp add --transport http klio https://mcp.klio.tech/mcp \
  --header "X-Klio-Key: YOUR_KEY" \
  --header "X-Klio-Agent: claude-code"
```

Get a key at [app.klio.tech](https://app.klio.tech) — the dashboard hands
you this exact command with the key filled in.

**Or self-host this repo** — the open-source core engine on your own
hardware, keys you hold, hash-chained history:

```bash
npx @klio-tech/klio init
```

These are different deployments of the same product: self-hosting is the
core memory engine, while the knowledge graph, hybrid recall, artifacts and
contradiction reconciliation run in Klio Cloud.

**[★ Star Klio on GitHub](https://github.com/klio-tech/klio)** if memory-that-survives-the-window-close sounds like a primitive every AI agent should have.

</div>

---

## What Klio is

Most AI agents work in isolation. Claude Code doesn't know what Cursor
just did. Cursor doesn't know what Codex decided yesterday. Each one
starts every session from zero — re-asking what you prefer,
re-deriving what you've already decided, forgetting the bug you spent
two hours on. The context evaporates the moment you close the window,
and there's no way for one agent to pick up where another left off.

**Klio is the shared substrate they all read from and write to.** A
local daemon that captures every prompt, decision, and tool call from
each of your AI agents, extracts the durable facts, embeds them with a
vector model, and serves them back as MCP tools so *any* MCP-aware
agent can recall them. Same store, every agent, across sessions and
across projects. Memory is the mechanism. Collaboration is the point.

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

### Future-proof — your accumulated knowledge outlives any model

As models, providers and tools change, everything your agents have
learned — decisions, constraints, proven solutions — stays yours, in a
store you run. Swap Claude for whatever comes next and the memory comes
with you. Klio doesn't just give your agents memory; it lets you build
your own intelligence layer that works with whatever AI arrives after
this one.

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
5. **Provisions an anonymous account**, then offers a one-keypress
   email-claim sub-prompt at the end of Phase 6 so security and
   breaking-change notifications can reach you. `⏎` to skip — the
   trust-app dashboard will surface a banner you can fill in later
   (or run `klio configure email <addr>` post-install).

Each adapter writes a timestamped backup of the file it modifies, so
`npx @klio-tech/klio uninstall` is non-destructive — it restores the
exact pre-Klio state for every agent.

### Cross-agent collaboration in real time

Every entry write publishes to Redis on `space:<space_id>`. A Cursor
instance can subscribe and receive frames within milliseconds — see
what Claude Code has just learned, decided, or planned, the moment it
happens. The protocol contract is stable:
`{type, space_id, frame_id, entry: {...}}`.

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

The six interactive phases:

| Phase                     | What happens                                                       |
|---------------------------|--------------------------------------------------------------------|
| 1. Stack boot             | `docker compose pull` + `up -d` for engine, bridge, dashboard, db. |
| 2. Provider pick          | OpenRouter (recommended), Ollama (fully local), or custom OpenAI-compatible. |
| 3. Model probe            | One-token test request validates the key + model before committing. |
| 4. Agent wiring           | All six adapters detect → backup → patch each agent's MCP config.   |
| 5. Memory curator         | One Y/n prompt enables the background synthesis job (defaults: on, hourly). |
| 6. Wow moment + email claim | You type one memory, the CLI proves recall, then a sub-prompt asks for an email so we can reach you for security/breaking-change notifications. `⏎` to skip. |

After install, you can change any of these settings without re-running
`init`:

```bash
npx @klio-tech/klio update                 # four-option picker
npx @klio-tech/klio update curator         # re-prompt schedule + model only
npx @klio-tech/klio update agents          # re-run adapter detection + wiring
npx @klio-tech/klio update provider        # change LLM provider / model
npx @klio-tech/klio update --check         # show running vs latest npm version
npx @klio-tech/klio update --to-latest     # pull + recreate at the latest tag
npx @klio-tech/klio update --to-version X  # pin every klio image to tag X (rollback path)
npx @klio-tech/klio update --watch         # long-lived host-side updater (apply mode)

npx @klio-tech/klio configure auto-update apply   # apply | notify | off
npx @klio-tech/klio configure email <addr>        # post-install email claim
```

Each `update <subcommand>` block re-prompts only its own slice and
restarts only the engine container. The `--check` / `--to-latest` /
`--to-version` flags are stack-wide and recreate engine + bridge +
trust-app together. `configure` writes to `~/.klio/.env` without
touching containers — the bridge daemon picks the new value up on
its next 6-hour ticker.

### Auto-update

Auto-update is **on by default** (`KLIO_AUTO_UPDATE=apply`). The
bridge daemon polls the npm registry every
`KLIO_UPDATE_CHECK_INTERVAL_SECS` (default 6h) and, when a newer
version is available, writes a sentinel at
`~/.klio/update-pending.json` and updates `~/.klio/update-state.json`.
Toggle to `notify` (write state, don't apply) or `off` (skip the
ticker entirely) with `klio configure auto-update`.

The actual `docker compose pull && up -d --no-deps engine bridge
trust-app` runs on the **host**, not inside the bridge container —
giving the bridge a docker CLI would force docker-in-docker or a
privileged docker.sock mount, both of which are unacceptable security
postures. Instead, the host-side process below consumes the sentinel
the bridge writes and applies it on the host's docker daemon.

To enable apply-mode auto-update, run the watcher in a long-lived
shell (or under launchd/systemd) on the host:

```bash
npx @klio-tech/klio update --watch
```

The watcher polls `~/.klio/update-pending.json` every 30 seconds. On
each tick it semver-validates the target, re-renders compose pinned
to the new tag, runs `docker compose pull && up -d --no-deps`, and
removes the sentinel. Failures (transient docker-hub rate-limits)
leave the sentinel in place so the next tick retries; invalid
sentinels (bogus version strings) are removed and surfaced as
`last_apply_error` in `~/.klio/update-state.json` so the dashboard
shows the operator what happened.

If you don't run the watcher, the bridge still notes available
updates (`last_known_available_version` in the state file, surfaced
in the dashboard) but no auto-apply happens — `notify` mode in
practice. You can always force a manual apply with
`klio update --to-latest` regardless of whether `--watch` is running.

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

This un-wires the local proxy, removes its supervisor, stops the proxy,
and then walks the same six adapters in reverse, restoring the
timestamped backup each one wrote at install time — your agent configs
return to their pre-Klio state byte-for-byte. Only the last step
(removing containers and volumes) needs Docker, and it is skipped
entirely on a Klio Cloud machine, so uninstall works on a host that has
never had Docker installed.

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

### The memory curator (background synthesis)

Mechanical capture (Claude Code's PostToolUse hook) is great at
recording what happened, but it produces a stream of `observation`
entries — raw tool calls — not the durable preferences, decisions, or
plans that make recall valuable downstream. Historically that gap was
filled by the user explicitly calling `remember` / `decide` / `plan`,
which most users forget to do.

The **Klio curator** closes that gap. It's a background async job
inside `klio-engine` that wakes up on a schedule (hourly by default),
reads the recent `kind=observation` entries for each user, hands them
to the existing `FactExtractor`, and writes the synthesised
`memory` / `decision` / `plan` / `note` entries back into the same
default space. Per-user single-flight prevents overlap; the cursor is
durably persisted in Postgres so a restart never re-processes the same
window. Off-by-default in earlier versions, **on by default from 0.5.0
onward** — the `klio init` flow now includes a one-keypress prompt to
confirm. Tune later via `klio update curator`.

### The local proxy (Klio Cloud, opt-in)

Hooks only reach agents whose harness has a hook surface — in practice
Claude Code. Every other agent writes memory through MCP tool calls and
contributes no evidence at all. The **local proxy** closes that gap from
the other side: it sits on `127.0.0.1:8787` between your agent and the
model API, and any agent that lets you override its base URL gets team
memory with no agent-side code whatsoever.

`klio init` (cloud mode) offers it **after** wiring your agents, and as
of 0.9.5 **defaults to yes** — a bare Enter accepts. It's the only
integration point that needs nothing from the agent, so leaving it off
by default meant most users never got the strongest version of the
product. Rerouting an agent's model calls is still the most invasive
thing this tool does to a machine, which is why the trade-offs print
before the prompt every time — but the proxy fails open, is revived by
the supervisor every 60s, is healed by `klio doctor`, and comes with
kill switches (below) and a one-command escape hatch (`klio uninit`),
so accepting is no longer the riskier default. Type `n` (or `no`) to
decline, or run `klio init` again later once you're ready. Accepting
points **Codex** at the proxy, installs a launchd/systemd supervisor
that re-checks every 60s, and starts the proxy.

**Claude Code is not wired to the proxy, and saying yes does not touch
`~/.claude/settings.json`.** Klio's hooks already cover it end to end —
injection on `SessionStart`, capture from `UserPromptSubmit`,
`PostToolUse` and `Stop` — regardless of how Claude Code authenticates.
On a Claude **subscription** it does not route to a custom base URL at
all, so the proxy would never even be contacted. Klio 0.9.4–0.9.6 wired
it anyway, which cost Remote Control (v2.1.196+ is incompatible with a
custom base URL, and no flag re-enables it) for nothing in return. As of
**0.9.7**, `klio init` and `klio doctor` take that back: they restore
the values recorded in `~/.klio/proxy-wiring.json` when Klio applied
them, so Remote Control works again. Only values Klio's own record says
Klio wrote are touched — anything you set yourself, or that no longer
matches what Klio writes, is left exactly as it is and reported.

**Non-interactive sessions always decline.** If stdin isn't a TTY
(CI, `npx @klio-tech/klio init < /dev/null`, any piped script) the
proxy offer is skipped and declined outright, regardless of the
default — `klio init` prints one line saying why and how to enable it
later (re-run `klio init` from a terminal). A default-yes prompt must
never resolve on its own just because nothing was there to answer it.

**What it does to a request.** On a `POST` whose path ends `/messages`
(Anthropic's Messages API) it appends one block of your team's Klio
memories to the request's `system` field; on a `POST` whose path ends
`/responses` (OpenAI's Responses API — what Codex speaks) it appends
the same block to `instructions`. Either way, after the response has
been fully forwarded, it sends the conversation to Klio as grading
evidence. That is all. `messages`, `input`, `tools`, `tool_choice`,
every `tool_reference` block and every tool-call id are forwarded byte
for byte. Every other request, every other path, and every other method
is forwarded unmodified.

Both shapes are captured under one transcript policy: tool blocks are
capped at 8 KB each, whole turns are dropped or truncated only to fit
the 256 KB payload cap, and plain message text is never cut on one path
and kept on the other. (Through 0.9.6 the Responses path capped message
text at 8 KB, so a 20 KB paste survived through Claude Code and arrived
at the grader gutted from Codex. Fixed in 0.9.7.)

**Fail open, always.** A failed recall, an unparseable body, a broken
capture endpoint, a body over 10 MB, an unexpected shape — every one of
them degrades to "forward the original bytes". The only response the
proxy ever authors is a `502` (in Anthropic's error envelope, with an
`x-klio-proxy-error` header) when the upstream is genuinely
unreachable.

**Your request never waits on Klio.** Recall happens in the background,
not in the request path: the proxy keeps a warm cache and reads it, so
forwarding is never delayed by however long the engine takes. A broad
team-context set is fetched at startup and refreshed every few minutes,
which is what lets even the first turn of a session inject something;
a question the cache has not seen is answered immediately from that set
(or from nothing) while a recall for it fills the cache behind you, so
the next turn on the same topic is warm. Repeat questions collapse to
one recall, never one per turn.

Every response carries two headers, so you can see what it did without
reading logs:

```
x-klio-injected: 11
x-klio-injected-reason: hit
```

`x-klio-injected` is how many memories were added. The reason says why
that number is what it is — `hit` (this question's own cache),
`ambient` (the broad team-context set), `cold` (first sight of this
question; a recall is now running), `empty` (nothing relevant),
`error` (recall failed or timed out — also one line on stderr),
`disabled`, `no-config`, `no-query`, `not-applicable`, or
`not-injectable`. A `0` with no reason to explain it is exactly how
"injection quietly does nothing" used to hide.

**Turning it off.** Two independent kill switches, no uninstall needed:

```bash
klio proxy capture off   # stop sending conversations to Klio
klio proxy inject off    # stop appending memories to the system prompt
klio proxy capture       # what is it set to, and where did that come from
```

Both are **on** by default whenever `~/.klio/config.json` holds a cloud
key. The choice is **saved in that same file** and survives a proxy
restart, a reboot, and a re-run of `klio init`; the command also
restarts a running proxy, so it takes effect immediately rather than
"at the next start".

`KLIO_PROXY_INJECT` and `KLIO_PROXY_CAPTURE` still work
(`off`/`false`/`0`/`no`) and override the saved setting — but **only for
a process your own shell starts**. That is the whole reason they are not
the durable switch: after `klio init` the proxy is started by launchd or
systemd, whose child inherits the *supervisor's* environment and never
sees your shell, so an exported variable was silently forgotten at every
restart. Use them for a one-off (`KLIO_PROXY_CAPTURE=off klio proxy
serve`); use `klio proxy capture off` for a decision.

**Commands.**

```bash
klio proxy status         # is it answering, what is it doing, and what is it set to
klio proxy serve          # run it in the foreground (this is how you see errors)
                          #   --port / --host / --upstream, or KLIO_PROXY_PORT /
                          #   KLIO_PROXY_HOST / KLIO_PROXY_UPSTREAM, to run a
                          #   second instance somewhere else while testing.
                          #   Precedence: flag > environment > default. These
                          #   affect `serve` only — status/ensure/stop/doctor
                          #   probe 8787, the port your agents are pointed at.
klio proxy stop           # stop it
klio proxy ensure         # what the supervisor runs every 60s: probe, revive if dead
klio proxy capture on|off # save and apply the capture kill switch
klio proxy inject on|off  # save and apply the injection kill switch
klio doctor               # check the whole wiring end to end, and repair what it can
klio uninit               # remove the wiring and stop the proxy — the escape hatch
```

If something *other than* Klio is listening on 8787, `klio proxy stop`
and `klio down` say so and leave it alone — they will never signal a
process they cannot prove is ours. `lsof -nP -iTCP:8787 -sTCP:LISTEN`
names the listener; deciding what to do with it is yours, because
selecting processes by port alone catches connected clients (your coding
agent among them), not just the listener.

`klio uninit` is the escape hatch and is designed to work when nothing
else does: it does not need Docker, does not need the proxy to be
reachable, and puts your agents straight back on `api.anthropic.com`.

**Known limitation.** A request body over 10 MB is forwarded raw and
unbuffered (never injected, never captured). If the CLIENT disappears
mid-upload of such a request, the proxy does not detect it and keeps
relaying the remaining body upstream — measured at up to ~30s and
~12.5 MB of wasted upstream traffic against a slow consumer. It costs
wasted bytes on a cancelled >10 MB upload, never a wrong response or a
hung client, and it matches the behaviour of the proxy that shipped
before this path existed. Three fixes were built and measured; two of
them broke healthy traffic (slow first-byte responses, long SSE gaps,
and backpressured uploads), so the leak ships documented rather than
traded for an outage.

### Architecture at a glance

```
trust-app (Next.js, container)  ◄─────►  engine (FastAPI, container)
  /memories                                ├── /v1/spaces
  /spaces                                  ├── /v1/spaces/{id}/entries
  /access-requests                         ├── /v1/spaces/{id}/recall
  /security                                ├── /v1/spaces/{id}/reembed
                                           ├── /v1/auth/login-link
                                           ├── /v1/audit
                                           ├── /v1/system/banners   (0.6.0)
                                           ├── /v1/curator/run-now  (0.5.0)
                                           └── ...

klio-bridge (Go, container)              ── packages two binaries:
  ├── klio-mcp   ◄─ MCP stdio shim         (consumed by every agent
  │                                          via `docker exec -i`)
  └── klio-daemon                          (long-running)
        ├── unix socket
        ├── SQLite cache
        ├── keychain backend
        ├── Redis subscriber
        └── updater ticker (0.6.0)        npm-registry poll + compose pull
                                           ~/.klio/update-state.json

bridge daemon              ◄─────────►  engine + Redis
                                           publishes + receives frames

Postgres + pgvector                       entries (encrypted)
                                          entry_embeddings_768/1024/1536
                                          audit_log (hash-chained)
                                          spaces (per-space embedding pin)
                                          users (envelope-key-wrapped)
                                          agents, permissions, access_requests
                                          audit_notarizations (OpenTimestamps proofs)
                                          curator_state (per-user cursor + counters)

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
│   └── tests/                 # vitest — 275+ hermetic unit tests
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
| Engine (FastAPI)           | ✅ 180+ tests passing (curator + banners)    |
| Bridge daemon (Go)         | ✅ 15 packages incl. updater, all green       |
| Trust-app (landing + dash) | ✅ typecheck + dual-target build green       |
| `@klio-tech/klio` (npm)    | ✅ published; 275+ tests passing             |
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
| Background curator         | ✅ shipped (0.5.0)                           |
| `klio update` subcommand   | ✅ shipped (0.5.0)                           |
| Auto-update bridge ticker  | ✅ shipped (0.6.0)                           |
| Email claim during init    | ✅ shipped (0.6.0)                           |
| `klio configure` / `klio update` flags | ✅ shipped (0.6.0)                |
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
- **Curator follow-ups:**
  - `klio curator run-now` subcommand on the Go bridge (today the
    `klio update curator --run-now` flag degrades gracefully when the
    bridge is too old — see `CHANGELOG.md` Known limitations)
  - Curator timeline view in the trust-app dashboard (per-tick stats,
    last synthesised entries, quick re-run)
  - Per-space curator config (different cadence + model per space)
- **0.6.x auto-update + claim follow-ups:**
  - **Email-on-major-version notifications.** The 0.6.0 ticker
    applies a new image and persists state, but the planned
    one-line summary email to claimed users on major-version landings
    is deferred to 0.6.1 (wiring point already exists in
    `bridge/internal/daemon/updater_ticker.go:runUpdateOnce`).
  - **Auto-rollback on healthcheck failure.** Today, if a new image
    fails its healthcheck, compose restarts 3 times then exits —
    operator must manually `klio update --to-version <previous>`
    to roll back. Watchtower-style failover is planned.
  - **launchd / systemd unit files for the host watcher.** v0.6.1
    ships `klio update --watch` as a long-running CLI a user runs in
    a terminal. v0.6.x will package platform-specific service files
    so the watcher survives reboots without a terminal session.
  - **GitHub OAuth as an alternate claim path.** Engine has no OAuth
    flow today; planned for v0.7 if user-pull warrants it.

**v1.0 — public launch**

- PyPI `klio-engine` package (the engine as a library, not just a container)
- Signed releases (Sigstore / Cosign)
- ~~Klio Cloud beta~~ — **live** at [app.klio.tech](https://app.klio.tech) (magic-link sign-up, free to start)
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
