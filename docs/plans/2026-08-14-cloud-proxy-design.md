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

## What the proxy does — stated honestly

**Today it does nothing.** Pass-through only; it does not alter a single byte.
That is deliberate and should stay deliberate: once `ANTHROPIC_BASE_URL` points
at localhost, a proxy that is down, slow, or subtly wrong does not degrade the
agent — it makes the agent **unable to reach a model at all**. The plumbing ships
and gets proven survivable while the blast radius is zero.

Its value is the named seam (`klio_proxy.seam`, and its Node equivalent) where
two things eventually live:

- **Compression** — token reduction on the request leg.
- **Context injection** — the only mechanism by which Klio can put memory into a
  request for an agent that supports neither hooks nor MCP.

Seam errors fail open: any exception a transform raises forwards the original
bytes unchanged.

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

- Any transform in the seam (compression, context injection). Plumbing only.
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
