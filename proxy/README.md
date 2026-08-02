# klio-proxy

A local HTTP proxy that sits between an AI coding agent and the Anthropic
Messages API.

**This stage ships pass-through only. It does not alter a single byte of
traffic.**

That is deliberate. The riskiest thing about the Klio Compression design
is being in the request path at all: once `ANTHROPIC_BASE_URL` points at
localhost, a proxy that is down, slow, or subtly wrong does not degrade
the agent — it makes the agent unable to reach a model at all. So the
plumbing ships and gets proven survivable while the blast radius is
zero. Compressors plug into `klio_proxy.seam` afterwards.

## What it guarantees

| Property | How |
|---|---|
| Responses stream | The response leg is a generator over `aiter_raw()`; nothing is accumulated. Buffering an SSE stream is invisible in a smoke test and obvious in real use. |
| Bodies are verbatim | Request bodies pass through the identity seam. Response bodies are forwarded raw — still compressed if the upstream compressed them. |
| Headers are verbatim | A *deny* list of hop-by-hop headers, never an allow list, so a header Anthropic adds tomorrow survives today's code. `anthropic-ratelimit-*`, `retry-after` and `request-id` all reach the client. |
| Status codes are verbatim | 4xx and 5xx bodies are forwarded, never rewritten into a proxy error. |
| `tool_reference` blocks survive | Stage 3 does not parse request bodies at all. See `tests/test_tool_reference.py` for why this matters more than it looks. |
| Failures are fast and named | The proxy cannot fail open when the upstream is unreachable, so it fails legibly instead: a 502 in Anthropic's error envelope plus an `x-klio-proxy-error` header. Never a hang. |
| Seam errors fail open | `apply_request_seam` catches every `Exception` a transform can raise and forwards the original bytes. |

## Why `tool_reference` is load bearing

Pointing `ANTHROPIC_BASE_URL` at a non-Anthropic host disables MCP Tool
Search by default. `klio init` re-enables it with
`ENABLE_TOOL_SEARCH=true`, which only works if the proxy forwards
`tool_reference` blocks correctly. Getting it wrong costs ~85% on tool
schemas — silently, while Klio claims to be saving tokens. A net loss
nobody can see is worse than no product at all.

## Running it

Normally you do not: `klio init` wires it up and a platform supervisor
keeps it alive. Directly:

```
KLIO_PROXY_PORT=8787 python -m klio_proxy
```

### Configuration

All environment, no config file to go stale.

| Variable | Default | Notes |
|---|---|---|
| `KLIO_PROXY_UPSTREAM_URL` | `https://api.anthropic.com` | Must be `http://` or `https://`. |
| `KLIO_PROXY_HOST` | `127.0.0.1` | Loopback by default — the proxy carries your API key. The container image sets `0.0.0.0` because Docker's `127.0.0.1:8787:8787` publishing enforces the boundary there instead. |
| `KLIO_PROXY_PORT` | `8787` | |
| `KLIO_PROXY_CONNECT_TIMEOUT` | `10` | Seconds. Fail fast rather than hang. |
| `KLIO_PROXY_READ_TIMEOUT` | `none` | No limit, deliberately. A long turn with extended thinking can stream for minutes with gaps; any finite value is a clock that eventually cuts off a working session. |

A malformed value exits with code 2 and names the variable, rather than
silently substituting a default and sending your traffic somewhere you
did not ask for.

### Endpoints

Everything is forwarded except `/__klio/health`, which is liveness only
and deliberately does not touch the upstream — otherwise an Anthropic
outage would make the supervisor restart a perfectly healthy proxy.
End-to-end reachability is `klio doctor`'s job.

## Tests

```
pytest
```

Both the fake upstream and the proxy run as real uvicorn servers on
loopback ports. In-process ASGI would skip the HTTP server, which is
exactly where the behaviours under test live — a passthrough test that
never touches a socket cannot tell a streaming proxy from a buffering
one.

**What the suite proves:** that the proxy does not alter what passes
through it, measured against the ground truth of the same request made
without a proxy.

**What it cannot prove:** that the real API accepts what we forward. The
upstream in these tests is a local fake. Only a live run closes that gap.

## Dependencies

FastAPI, uvicorn, httpx. Nothing else, and specifically not the Klio
engine, postgres or redis — the proxy must boot and serve with the rest
of the stack down. Every dependency added here is another way for the
agent to lose its model.
