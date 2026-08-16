# Docker-free local proxy for Klio Cloud — design

**Date:** 2026-08-14
**Status:** Approved in conversation. Ready for an implementation plan.

---

## Why

The compression proxy exists, is tested, and is wired into the local stack. Cloud
users cannot have it — not for any technical reason, but because it ships as a
Docker service and Docker is the one thing the cloud path exists to avoid.

That inversion matters: **Cloud is the paid product, and it is the tier missing
the one injection point that works without the agent's cooperation.** Hooks need
a harness that supports them. MCP needs the agent to choose to call a tool. A
local proxy needs neither — it only needs the agent to let you override its model
base URL.

The proxy has three dependencies (`fastapi`, `uvicorn`, `httpx`), touches no
database, no Redis, and no engine. The only mention of the engine in its entire
source is a comment explaining why it deliberately does not share the engine's
dependency tree. It was never cloud-incompatible; it was packaged with things
that are.

## Decisions taken

| Decision | Rationale |
| --- | --- |
| **Port the proxy to Node, ship it inside the existing CLI** | Zero new runtime for the user — `npx` already ran. `klio-proxy` is not on PyPI (404), and macOS ships Python 3.9, so a `uvx` path would fail on a meaningful share of fresh Macs at the worst moment: first run. |
| **Cloud only; the Python container stays** | Smallest blast radius. `init --local`'s proven path is untouched. The divergence hazard is real and is mitigated by porting the test suite, not by hoping. |
| **Wire Claude Code AND Codex** | `codexProxy.ts` already exists and works. Shipping only Claude Code would leave working code unused. |
| **Default the prompt to NO** | Pointing `ANTHROPIC_BASE_URL` at localhost is the most invasive thing this tool does. A cloud user signed up to avoid running things; they must opt in, not opt out. |

## What the proxy does: injection + capture, shipped

A pass-through proxy is worth nothing to a cloud user. The Python proxy shipped
pass-through-only to prove the *shape* survivable, and it has — in the local
stack, under a supervisor, in real use. That trust does not need re-earning from
zero. **This build ships the injection transform**, because injection is the
entire reason the proxy is worth having:

> It is the only mechanism that puts Klio's memory into a request without the
> agent's cooperation — no hook support required, no tool call required, no
> agent-side code at all. Any agent that lets you override its base URL gets
> team memory, including one someone wrote themselves last night.

Compression stays out of scope. Two capabilities — inject on the way out,
capture on the way back — both done carefully.

### Capture: the proxy closes the loop for hookless agents

Capture today lives in `bridge/internal/hooks` and reaches only agents whose
harness supports hooks — in practice, Claude Code. Codex, Cursor and Claude
Desktop all write memories through MCP, and **not one of their sessions is ever
retained, graded, or attributed.** Most agents contribute nothing to the
evidence loop.

The proxy sees the entire conversation on every request. That makes it the one
place a hookless agent's session can be captured, so a proxied agent becomes
self-sufficient: **it receives context and it contributes evidence**, with no
harness support at all.

- On each proxied messages request, the injector already parses the body. The
  same parse yields the conversation.
- Capture is emitted **after the response is fully forwarded** — never in the
  request path, never blocking the model call.
- It POSTs to the engine's existing `/capture/transcript` with a
  proxy-derived session id (`klio-proxy:<agent>:<conversation-hash>`), the same
  endpoint and shape the hooks use, so traces, grading and attribution all work
  unchanged downstream.
- Emission is best-effort and fire-and-forget: a capture failure is logged and
  dropped. It can never affect the agent.
- Governed by `KLIO_PROXY_CAPTURE=on|off`, and off whenever injection is off.

### The constraint that actually binds

Not "never parse bodies" — that is a description of how the pass-through stage
achieves its guarantee, not a prohibition on later stages; the same README
plans for compressors in the seam, and a compressor must read the body.

The real constraint, from `proxy/README.md`, is narrower and sharper:
**do not break `tool_reference` blocks.** Pointing `ANTHROPIC_BASE_URL` at a
non-Anthropic host disables MCP Tool Search; `klio init` re-enables it with
`ENABLE_TOOL_SEARCH=true`, and that only works if `tool_reference` blocks are
forwarded correctly. Getting it wrong costs ~85% on tool schemas — *silently*,
while Klio claims to be saving tokens. A net loss nobody can see is worse than
no product at all.

So: **parse narrowly, mutate one field, never touch `tools`, and forward the
original bytes on any doubt.** Six rules make that safe:

1. **Path allowlist.** Only `POST` to the messages endpoint is ever parsed.
   Every other request keeps the existing byte-exact path, untouched.
2. **One field, append-only.** Injection appends a single block to `system`.
   `messages`, `tools`, `tool_choice` and every `tool_reference` block are never
   read, never rewritten, never re-ordered. The Anthropic API accepts `system`
   as a string or an array of blocks; a string is promoted to a two-element
   array with the original first.
3. **Structural round-trip check.** After mutation, the serialized body is
   re-parsed and compared against the original for every top-level key except
   `system`. Any difference — key order is not a difference, key *content* is —
   forwards the original bytes.
4. **Fail open, always.** Parse failure, recall failure, timeout, oversize body,
   unexpected shape: forward the original bytes. There is no error path in which
   the agent's request does not reach the model.
5. **Bounded latency.** ~~The recall runs with a hard **300 ms** timeout.~~
   **AMENDED 2026-08-15 — the request path makes no recall call at all.** The
   300 ms budget was written here as a guess; production recall measured
   **5.90 / 6.18 / 6.47 s**, so every request timed out, nothing was ever
   injected, and — because the timeout path cached nothing — nothing ever
   warmed. The intent of this rule was "the proxy must never make a model call
   slower in a way a user would notice", and a request-path fetch cannot honour
   that against a ~6 s endpoint at any budget. So recall moved off the request
   path entirely: the request performs a **cache read only**, and background
   warming (an ambient org-scoped set on an interval, plus a single-flighted
   per-query fetch on each miss) fills that cache on a generous but bounded
   budget. The rule is unchanged; only its mechanism is.
6. **Off by default per-request via kill switch.** `KLIO_PROXY_INJECT=off`
   restores exact pass-through without uninstalling anything.

### Cost control

Recalling on every request would be both slow and expensive. The injector keeps
a small in-process cache keyed by a hash of the conversation's last user
message, TTL 60 s. A tight agent loop on one task therefore recalls once, not
forty times. ~~Cache misses that exceed the 300 ms budget simply do not
inject.~~ **AMENDED 2026-08-15:** a miss injects whatever the ambient set
offers (or nothing) and returns immediately, while a background fetch fills the
cache; concurrent misses for one query are single-flighted, and a stale entry is
served while it refreshes rather than dropped.

### Observability

Every response carries `x-klio-injected: <n>` — the number of memories added,
`0` when injection was skipped. One header answers "is this thing doing
anything?" without reading logs, and makes the no-op case visible rather than
ambiguous.

**AMENDED 2026-08-15 — it was not enough.** `0` meant five different things
(disabled, no config, cold cache, no memories, error/timeout), so a proxy that
injected nothing on every single request in production looked exactly like a
proxy with nothing relevant to say. Responses now also carry
`x-klio-injected-reason`, and an error or timeout additionally logs one
throttled line — with no query text, no memory content and no credentials in
either place.

## Architecture

Nothing about the existing supervisor contract changes. `wireProxy`, the
launchd/systemd unit installer, `probeProxy` against `/__klio/health`, and the
`klio proxy ensure|status` exit codes (`0` answering, `1` could not fix) are all
transport-agnostic — they care only that something answers on `127.0.0.1:8787`.

```
  agent (Claude Code / Codex / anything with a base-URL override)
        │  ANTHROPIC_BASE_URL=http://127.0.0.1:8787
        ▼
  ┌──────────────────────────┐
  │  klio proxy (Node)       │   ← new: runs as a process, not a container
  │  seam: identity for now  │
  └───────────┬──────────────┘
              │ verbatim
              ▼
        api.anthropic.com

  supervisor (launchd / systemd, every 60s)
        │  probe /__klio/health
        └─ fail → revive:  cloud = spawn process   (new)
                           local = docker compose  (unchanged)
```

### 1. `npm/src/proxy/server.ts` — the proxy

Node's built-in `http` server plus `undici` for the upstream leg. It must
reproduce, byte for byte, the guarantees the Python implementation documents and
tests:

- **Streaming, never buffered.** Pipe the upstream body straight through.
  Buffering an SSE stream passes a smoke test and breaks real use.
- **Verbatim bodies.** No parsing of request bodies at all — this is what keeps
  `tool_reference` blocks intact.
- **Verbatim headers via a DENY list**, never an allow list, so a header
  Anthropic adds tomorrow survives today's code. Port `HOP_BY_HOP_HEADERS` and
  the request-only drops from `headers.py`. `anthropic-ratelimit-*`,
  `retry-after` and `request-id` must reach the client.
- **Verbatim status codes.** 4xx/5xx bodies forwarded, never rewritten into a
  proxy error.
- **Fail fast and legibly.** Upstream unreachable returns 502 in Anthropic's
  error envelope plus an `x-klio-proxy-error` header. Never a hang.
- **Same endpoints:** `GET /__klio/health`; `/__klio/upstream/<name>` prefix
  routing for named upstreams.
- **Same env contract:** `KLIO_PROXY_PORT` (8787), `KLIO_PROXY_HOST`
  (127.0.0.1), and the upstream base URLs, so both implementations read the same
  configuration.

New subcommand `klio proxy serve` runs it in the foreground; the supervisor
spawns that.

### 2. `npm/src/proxy/processSupervisor.ts` — revive without Docker

`composeUpService` becomes one of two strategies behind the existing interface:

- **local** → `docker compose up -d proxy` (unchanged)
- **cloud** → spawn `node <cli> proxy serve` detached, write a PID file beside
  the existing state file

`ensure` keeps its exit-code contract exactly. Mode is read from the same state
the CLI already writes at init; there is no new source of truth.

### 3. `initCloud` offers it

One prompt after agent wiring, **defaulting to no**, shown only when Claude Code
or Codex is detected. Accepting installs the supervisor unit and calls the
existing `wireProxy` for both agents. `klio uninit` already knows how to unwire
and needs no change.

## Testing

The Python tests *are* the contract. Port them against the Node server, reusing
the same fake-upstream shape:

| Ported from | Proves |
| --- | --- |
| `test_passthrough.py` | bodies, headers, status codes verbatim |
| `test_streaming.py` | SSE streams are not buffered |
| `test_tool_reference.py` | `tool_reference` blocks survive |
| `test_failure_modes.py` | 502 envelope, `x-klio-proxy-error`, never a hang |
| `test_upstream_routing.py` | `/__klio/upstream/<name>` selection |

Plus one the Python suite cannot have: **process-supervisor revive after a
kill** — `ensure` brings a killed proxy back and exits `0`.

A Node proxy that passes all of these is behaviourally the Python one.

## Risks, named

- **Two implementations of a byte-exact streaming proxy.** Accepted for now. The
  ported suite holds both to one contract. Convergence — Node everywhere, delete
  the container — is a deliberate follow-up, not an accident to drift into.
- **Being in the request path.** Mitigated exactly as the Python one mitigates
  it: pass-through only, fail-fast-and-named, seam errors fail open, and an
  opt-in prompt that defaults to no.

## Out of scope

- Compression. Injection and capture only.
- Converting the local stack to the Node proxy.
- Agents without a base-URL override. Cursor routes most models through its own
  backend; there is frequently no request of yours to intercept. Cloud agents
  (claude.ai, ChatGPT) can never be proxied — their model calls happen on
  someone else's servers.

## Related, decided, not in this spec

Publish a Klio skill to the `skills` registry (`npx skills add`). Caveman reaches
its advertised 30+ agents that way — via a static rule file, not via their proxy,
whose story is the same env-var override as ours. A rule file can carry an
instruction ("recall from Klio before you start") but not live data, so this buys
distribution and a nudge, never the evidence loop. Worth roughly an hour; track
separately.
