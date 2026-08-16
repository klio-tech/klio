# Proxy — manual verification against a real model API

Every automated test of the cloud proxy runs against a **fake upstream**: a
local script that speaks Anthropic's response shape. 591 tests pass against it.
This document is the one place where the proxy was driven against a **real
remote model API, over real TLS, with the real global `fetch`**, and where what
was actually observed is written down — including the two things that did not
work.

Read the failures section before trusting the passes. An honest gap is worth
more than an implied pass.

---

## Run metadata

| | |
|---|---|
| Date | 2026-08-15 (UTC) |
| Branch / commit | `feat/cloud-proxy` @ `e0afb49` |
| Package version | `@klio-tech/klio` 0.9.4 |
| Node | v22.22.3 (macOS, darwin 25.5.0) |
| Upstream | `https://litellm.oppla.dev` (org LiteLLM gateway, Anthropic-shaped `/v1/messages`) |
| Model | `xai/grok-4.1-fast-non-reasoning` |
| Klio engine | `https://mcp.klio.tech` (production) |
| Database | production Postgres (Neon), queried directly with `psycopg2` |

**Not Anthropic.** The upstream is the organisation's own LiteLLM gateway,
which serves an Anthropic-shaped Messages route and is free to this account.
Everything that depends only on the Messages wire format is fully exercised by
it. Everything that is an *Anthropic platform* construct — `tool_reference`
blocks above all — is **not**, and is called out in
[Not verified](#not-verified-do-not-read-these-as-passes) below.

### How the proxy was run

This machine's port 8787 carries the user's real, supervised proxy (pid 87493),
which must not be disturbed, and the run needs a different upstream. Both are
now **real CLI seams** (added by the warming commit — see
[§8](#8-background-warming--pass-2026-08-15)):

```bash
klio proxy serve --port 18787 --upstream https://litellm.oppla.dev
#     equivalently: KLIO_PROXY_PORT / KLIO_PROXY_HOST / KLIO_PROXY_UPSTREAM
```

> **The original run of §1–§7 could not do this.** `PROXY_PORT` was a hard-coded
> `8787`, `KLIO_PROXY_PORT` reached only the Docker/Python proxy, and the
> upstream map was a programmatic option with no CLI or env path to it — so that
> run used a copy of the built artifact with two literals patched by hand
> (`dist/proxy/constants.js`'s port → `18787`, `dist/proxy/server.js`'s
> `api.anthropic.com` → `https://litellm.oppla.dev`). A verification that
> requires patching compiled output is one nobody repeats, which is why the
> seams exist now. §1–§7 below still describe the patched-copy run as it
> happened; §8 was run on the seams, unpatched.

In both runs `HOME` pointed at a throwaway `mkdtemp` directory holding its own
`~/.klio/config.json` (a copy of the real credentials). The real `~/.klio/`,
`~/.claude/`, `~/.codex/`, `~/Library/LaunchAgents/` and port 8787 were never
written to; `launchctl` was never invoked. Hashes of all real files were
compared before and after — see
[Machine state](#machine-state-after-the-run).

A second copy at `<scratch>/task8/cli-budget/` (port 18788) additionally raised
`DEFAULT_BUDGET_MS` in `dist/proxy/recall.js` from `300` to `15000`. That copy
exists only to isolate the cause of finding **F-1** and is labelled everywhere
it is used.

Credentials are redacted throughout. The LiteLLM key was read from Railway into
a 0600 scratch file and never printed, logged, or written to any file in this
repository.

---

## Results

| # | Check | Result |
|---|---|---|
| 1 | Health endpoint answers with `mode`/`runtime`/`pid`/`config_fingerprint`, no key | **PASS** |
| 2 | Pass-through fidelity against a real remote host (200s and error envelopes) | **PASS** |
| 3 | Streaming is progressive, not buffered | **PASS** |
| 4 | Injection reaches a real model | **FAIL** — see F-1 |
| 5 | Capture lands in `session_traces` | **PASS** (with a caveat — see F-2) |
| 6 | Kill the proxy, `klio proxy ensure` revives it, exits 0 | **PASS** |
| 7a | `KLIO_PROXY_INJECT=off`, live | **PASS** |
| 7b | `KLIO_PROXY_CAPTURE=off`, live | **PASS** |
| 7c | Persisted `klio proxy capture off` | **PASS** |
| 8 | Background warming: injection fires without the request path waiting | **PASS** — F-1 fixed, see §8 |

---

## 1. Health — PASS

```bash
HOME=$TMPHOME node $CLI/bin/klio.mjs proxy serve &
curl -s http://127.0.0.1:18787/__klio/health
```

```json
{"status":"ok","mode":"inject+capture","runtime":"node","pid":32491,"config_fingerprint":"09d171925bfcbc21"}
```

All four discriminators present. `mode` tracks the toggles across the run:
`inject+capture` → `capture` (7a) → `inject` (7b, 7c). The API key never
appears — only the 16-hex fingerprint, which matched the real supervised
proxy's fingerprint (same credentials), confirming the digest is stable and
derived from the config rather than the process.

## 2. Pass-through fidelity against a real remote — PASS

Same request sent directly to LiteLLM and through the proxy with injection off
(`KLIO_PROXY_INJECT=off`, health `mode: "capture"`).

```bash
Q='{"model":"xai/grok-4.1-fast-non-reasoning","max_tokens":16,"messages":[{"role":"user","content":"say ok"}]}'
curl -s -D d.h -o d.json https://litellm.oppla.dev/v1/messages   -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" -d "$Q"
curl -s -D p.h -o p.json http://127.0.0.1:18787/v1/messages      -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" -d "$Q"
```

**Status:** 200 both.

**Body**, identical modulo the two fields that are non-deterministic per call
(`id`, `usage`):

```
direct : {"content":[{"text":"ok","type":"text"}],"model":"xai/grok-4.1-fast-non-reasoning","role":"assistant","stop_reason":"end_turn","stop_sequence":null,"type":"message"}
proxied: {"content":[{"text":"ok","type":"text"}],"model":"xai/grok-4.1-fast-non-reasoning","role":"assistant","stop_reason":"end_turn","stop_sequence":null,"type":"message"}
IDENTICAL(modulo id,usage): True
```

**Headers.** Every upstream header survived the hop, including the whole
`x-litellm-*` family (`x-litellm-model-id`, `-response-cost`, `-attempted-retries`,
`-version`), `x-railway-request-id`, `x-hikari-trace`, `server`, `vary`, and the
security headers (`content-security-policy`, `x-content-type-options`,
`x-frame-options`). This is the deny-list behaviour in `headers.ts` working
against a header set nobody wrote a fixture for.

Differences, all expected and all explained by existing code comments:

| Header | Direct | Proxied | Why |
|---|---|---|---|
| `content-length: 278` | present | absent, `Transfer-Encoding: chunked` | `RESPONSE_ONLY_DROPS` — the body is re-streamed |
| `x-klio-injected` | — | `0` | added by the proxy |
| protocol | HTTP/2 | HTTP/1.1 | loopback `http.Server` is HTTP/1.1 |

**Real error envelopes**, the first time these have been compared against a
real remote rather than a fixture. Both were **byte-identical** direct vs
proxied, with the status preserved:

* Invalid model → `400`
  `{"error":{"message":"400: {'error': 'anthropic_messages: Invalid model name passed in model=xai/no-such-model-klio-test. …'}","type":"None","param":"None","code":"400"}}`
* Invalid key → `401`
  `{"error":{"message":"Authentication Error, Invalid proxy server token passed. …","type":"token_not_found_in_db",…}}`

Note the 401 case: the proxy relayed an upstream auth failure **verbatim**
rather than authoring its own — the fail-open contract holds against a real
rejection.

## 3. Streaming is progressive — PASS

`stream:true`, read chunk by chunk with the real `fetch` reader, timestamps
relative to request start.

Comparison run (60-number count, `max_tokens: 400`):

| | headers | first chunk | total | chunks | bytes |
|---|---|---|---|---|---|
| direct | 1201 ms | 1202 ms | 1424 ms | 18 | 15756 |
| **proxied** | 1436 ms | **1436 ms** | **1688 ms** | 18 | 15756 |

Identical chunk count and identical byte count — the tee is not recombining or
splitting frames.

Longer run through the proxy (200-word story, `max_tokens: 600`): **100 chunks,
first at 1677 ms, last at 3079 ms** — 1.4 s of continuous delivery. Arrival
timeline (ms, first 12): `1677, 1704, 1713, 1727, 1739, 1746, 1756, 1766, 1847,
1851, 1870, 1884`. A buffered implementation would show `first_chunk_ms ≈
total_ms` and one chunk; this is the opposite of that.

`content-type: text/event-stream; charset=utf-8` was preserved, and
`x-klio-injected` was present on the streaming response.

## 4. Injection reaches a real model — **FAIL at `e0afb49`**, fixed in §8 (F-1)

With injection **on** against production Klio, the outgoing `system` carried
nothing:

```bash
curl -s -D h -o b.json http://127.0.0.1:18787/v1/messages -H "x-api-key: $KEY" … \
  -d '{"model":"xai/grok-4.1-fast-non-reasoning","max_tokens":120,"messages":[{"role":"user",
       "content":"Using only the Klio team context you were given, what domain is the Klio app served under, and what is the team website? Answer in one line."}]}'
```

```
x-klio-injected: 0
model answer: "I do not have any provided Klio team context."
```

Identical to the control sent straight to LiteLLM with no proxy in the path.

### F-1 — the recall budget is ~20× smaller than production recall latency

`src/proxy/recall.ts` gives recall a **300 ms** wall-clock budget
(`DEFAULT_BUDGET_MS`), after which it returns `[]` and the request is forwarded
uninjected. Measured against the production engine, the endpoint the proxy
actually calls:

```bash
curl -o /dev/null -w "%{time_total}\n" -X POST https://mcp.klio.tech/capture/recall \
  -H "X-Vex-Key: <redacted>" -H "X-Vex-Agent: klio-abhisheks-macbook-pro-local" \
  -d '{"query":"What domain is the Klio app served under","limit":8,"scope":"org"}'
```

```
6.179818 s
6.474845 s
5.895238 s
```

Three consecutive calls, 5.9–6.5 s each, against a 300 ms budget. The timeout
path caches nothing, so it does not warm up — **injection can never fire in
this configuration**. Fail-open works exactly as designed (the request still
reached the model, correctly, at no latency cost worth naming), which is
precisely why this is silent: nothing in the CLI reports it, and
`x-klio-injected: 0` is indistinguishable from "no relevant memories".

**The injection mechanism itself is sound.** Isolated by re-running the same
request through the `cli-budget` copy (`DEFAULT_BUDGET_MS = 15000`, port 18788,
everything else identical):

```
total=10.963249s
x-klio-injected: 13
model answer: "The Klio app is served under app.klio.tech, and the team website is klio.tech."
```

13 memories injected, and the model's answer reproduces content that exists
only in the Klio org's memory — against the same control that answered "I do
not have any provided Klio team context." So the `system` block was built,
forwarded, and read by a real model. The blocker is the budget, and only the
budget.

Note the second number too: **10.96 s total**, of which ~6 s was recall on the
request path. Raising the budget is not a fix on its own — it would move the
failure from "silently no injection" to "every model call waits 6 s". This is a
finding for triage, not something to patch here.

Not fixed in this task, per instruction. **Fixed in §8.**

## 5. Capture lands — PASS (F-2)

Capture requires a conversation that already has an assistant turn
(`conversationSessionId` returns `null` on turn 1 by design), so a three-message
exchange was sent through the proxy with capture on, carrying a unique marker.

```bash
# messages: [user "Remember this verification marker: klio-proxy-live-verify-20260815-1786781363",
#            assistant "Acknowledged, marker … recorded.",
#            user "Repeat the verification marker exactly once."]
curl -s http://127.0.0.1:18787/v1/messages … -d "$Q"    # → 200
```

Queried directly against the production database:

```sql
SELECT session_id, org_id, agent_id, message_count, tool_calls_count,
       redaction_version, transcript_ref, created_at
  FROM session_traces
 WHERE session_id LIKE '%klio-proxy:%'
 ORDER BY created_at DESC LIMIT 3;
```

```
session_id      : klio-hook:be3b0e93-…-…:u:c3c77f54-…:klio-proxy:klio-abhisheks-macbook-pro-local:2721a1bb44089624
org_id          : be3b0e93-bf64-467a-8545-f13082a92c27
agent_id        : klio-abhisheks-macbook-pro-local
message_count   : 4
tool_calls_count: 0
redaction_version: 1
transcript_ref  : s3://agentguard-traces/traces/be3b0e93-…/…/1a2a4406-e20c-4f50-abbb-4275e7ca84c0.json
created_at      : 2026-08-15 08:10:09.305876+00
```

Exactly one row, created at the moment of the proxied exchange, `message_count`
4 (three sent + the assistant reply), agent id matching the temp-HOME config,
transcript persisted to object storage. This is a database read, not an
inference from a 2xx on the capture POST.

### F-2 — the documented query does not find the row (minor, docs-level)

The task brief and the plan both specify `WHERE session_id LIKE 'klio-proxy:%'`.
That returns **zero rows**: the engine namespaces the id it receives, storing
`klio-hook:<org_id>:u:<user_id>:` + the proxy's own
`klio-proxy:<agent>:<hash>`. The working predicate is `LIKE '%klio-proxy:%'`.
The CLI is correct; the documented verification query is not. Anyone using the
brief's query verbatim would conclude, wrongly, that proxy capture is broken.

## 6. Kill and revive — PASS

```bash
kill -9 34757                                    # the running proxy's pid, from /__klio/health
curl -s --max-time 3 http://127.0.0.1:18787/__klio/health   # → <no response>

HOME=$TMPHOME node $CLI/bin/klio.mjs proxy ensure
```

```
klio proxy: not answering (fetch failed) — restarting
klio proxy: back up
exit=0
```

```json
{"status":"ok","mode":"inject","runtime":"node","pid":34874,"config_fingerprint":"09d171925bfcbc21"}
```

New pid, exit 0, and the revived process serves real traffic — a follow-up
proxied call returned `200` with the model's answer (`"revived"`) and
`x-klio-injected: 0`. The real machine's launchd supervisor was not used and
not touched; this exercised `ensure` → `probeProxy` → `spawnProxy` →
`proxy serve` directly.

## 7. Kill switches, live

### 7a. `KLIO_PROXY_INJECT=off` — PASS

```bash
HOME=$TMPHOME KLIO_PROXY_INJECT=off node $CLI/bin/klio.mjs proxy serve &
curl -s http://127.0.0.1:18787/__klio/health
```

```json
{"status":"ok","mode":"capture","runtime":"node","pid":33200,…}
```

`mode` drops `inject` and keeps `capture` — the two switches are independent,
as intended.

### 7b. `KLIO_PROXY_CAPTURE=off` — PASS

```json
{"status":"ok","mode":"inject","runtime":"node","pid":34505,…}
```

A second capture-eligible three-message exchange was then sent through the
proxy (200, correct model answer). The database count was **unchanged**:

```
klio-proxy rows: (1, 2026-08-15 08:10:09.305876+00)
```

Same single row from check 5, same timestamp. Nothing new left the machine.

### 7c. Persisted `klio proxy capture off` — PASS

```bash
env -u KLIO_PROXY_CAPTURE HOME=$TMPHOME node $CLI/bin/klio.mjs proxy capture off
```

```
klio proxy: capture is now off (saved in $TMPHOME/.klio/config.json)
  capture = sending conversations to Klio as grading evidence
  Restarted — alive (inject)
exit=0
```

* Config file after: `{"agentId": …, "baseUrl": …, "proxy": {"capture": false}}`
* **The API key survived the read-modify-write** — byte-compared against the
  source config: `apiKey preserved through toggle write: True`.
* The running proxy was restarted in place, `pid 34752 → 34757`, health `mode:
  "inject"`. The setting was applied, not merely recorded.
* `klio proxy status` reports the provenance:

```
klio proxy: alive (inject)
  inject: on (default)
  capture: off (saved setting in $TMPHOME/.klio/config.json)
```

---

## 8. Background warming — PASS (2026-08-15)

**What changed.** The 300 ms budget is gone from the request path entirely.
`recall.ts` is now a warm cache that the request path READS (synchronously, no
socket, no wait) and a background warmer that FILLS. Two layers: an ambient
org-scoped set fetched at startup and every 5 min, and a per-query
fire-and-forget fetch started on each miss, single-flighted. Every response also
carries `x-klio-injected-reason`, so `0` is never ambiguous again.

### How this run differs from §1–§7

* **No patched literals.** The real `dist` build, driven as
  `klio proxy serve --port 18787 --upstream https://litellm.oppla.dev`.
* **The engine calls were counted.** The temp HOME's `baseUrl` pointed at a
  local forwarder that relays verbatim to the real `https://mcp.klio.tech` and
  records every call. So "exactly one upstream recall" below is an observation,
  not an inference.

### Per-turn results — real engine, real model

Recall latency observed through the forwarder during this run: **6.5 s, 6.6 s,
9.5 s, 9.9 s** (`/capture/recall`, production).

| Turn | Wall clock | `x-klio-injected` | reason | Model answer |
|---|---|---|---|---|
| T1 first ever turn | 1505 ms | 0 | `cold` | "I do not have any provided Klio team context…" |
| T2 immediate repeat | 1488 ms | 0 | `cold` | same |
| *(9 s pause — the background recall lands out of the request path)* ||||
| T3 after warm-up | 1699 ms | **11** | `hit` | "The Klio app is served under app.klio.tech and the team website is klio.tech." |
| T4 3-message, same last user | 1581 ms | **11** | `hit` | same |
| T5 new question, never asked | 1952 ms | **13** | `ambient` | answers from org memory |
| T6 same question, warmed | 2360 ms | **8** | `hit` | answers from org memory |
| control: straight to the model | 1467 ms | — | — | "I do not have any provided Klio team context…" |

Read the two columns together. Every turn completed in **1.5–2.4 s** — the same
range as the unproxied control (1467 ms) — while the recall those turns were
served from took **6.5–9.9 s**. That is the whole fix: the latency did not get
smaller, it stopped being on the request path. Compare §4's naive
budget-raising measurement: **10.96 s**, ~6 s of it recall, for the same
injection.

`ambient` on T5 is layer 1 doing its job: a question nobody had asked yet, on a
proxy that had been up for one exchange, still received 13 org memories and
answered from them.

### The request path never waits — the same scenario, before and after

Against a deliberately slow (6 s) local recall endpoint, driven through a real
proxy (`tests/proxyWarming.test.ts` harness). At `ca2d5e8`:

```
A. multi-turn, same query, 6s engine
   turn 1: 333ms  x-klio-injected=0  reason=(absent)
   turn 2: 311ms  x-klio-injected=0  reason=(absent)
   turn 3: 315ms  x-klio-injected=0  reason=(absent)
   turn 4: 311ms  x-klio-injected=0  reason=(absent)
   upstream recall calls for that one query: 4
B. single-flight: 20 concurrent misses for one query
   slowest turn 335ms; injected=0
   upstream recall calls: 20
C. reason header present? NO — x-klio-injected-reason is absent
```

Four turns, four recalls, nothing ever injected, and 300 ms of the user's time
spent per turn achieving that. After the fix, the same shape injects on turn 2
onward and issues **one** recall for twenty concurrent misses.

### Single flight, against the real engine

Ten concurrent proxied turns carrying one never-before-seen query:

```
10 concurrent turns: max 2302ms, reasons=ambient
upstream recalls for that query: 1  (latencies: 6526ms)
```

One recall for ten turns, and none of the ten waited on it.

### The reason header, live

| Condition | `x-klio-injected` | `x-klio-injected-reason` |
|---|---|---|
| warm cache | 11 | `hit` |
| ambient set only | 13 | `ambient` |
| first sight of a query | 0 | `cold` |
| `KLIO_PROXY_INJECT=off` (health `mode: capture`) | 0 | `disabled` |
| no cloud config (health `mode: passthrough`) | 0 | `no-config` |
| `GET /v1/models` | 0 | `not-applicable` |

`empty` (recall answered with nothing), `error` (engine 5xx, network failure, or
the background budget expiring) and `not-injectable` (memories in hand, body not
safely mutable) are covered in `tests/proxyWarming.test.ts` and
`tests/proxyRecall.test.ts`; `error` additionally emits one throttled stderr
line carrying no query text, no memory content and no credentials. Nothing was
logged during this run — there were no failures.

### Capture is unaffected

The three-message turn (T4) produced a `POST /capture/transcript` → `200`
through the same forwarder, as before. Note the query predicate for finding it
(F-2): `LIKE '%klio-proxy:%'`, never the anchored `'klio-proxy:%'`.

### What warming does NOT cover

* **Tool-result turns.** In an agent loop the last `user` message is often a
  `tool_result` block with no text, so the recall query is empty and the reason
  is `no-query`. Those turns fall back to the ambient set, which is exactly what
  layer 1 is for — but they never get a query-specific recall.
* **Relevance is not monotonic.** T6's query-specific recall (8 memories) gave a
  worse answer than T5's ambient set (13). Warming makes injection *happen*; it
  does not make the engine's ranking better.
* **First turn of a fresh process, before ambient lands.** The ambient fetch is
  started at boot and takes ~6–10 s; requests inside that window report `cold`.

---

## Not verified — do not read these as passes

### `tool_reference` survival against the real Anthropic API — UNVERIFIED

`tool_reference` is an **Anthropic MCP Tool Search construct**. LiteLLM and xAI
do not implement it, so nothing in this document says anything about it. This
matters more than any single check above: `src/proxy/constants.ts` records that
pointing `ANTHROPIC_BASE_URL` at a non-Anthropic host disables MCP Tool Search,
which `klio init` re-enables with `ENABLE_TOOL_SEARCH=true` — and that only pays
off if `tool_reference` blocks cross the proxy hop intact. Breaking them is a
**~85% silent loss on tool schemas**, while Klio claims to be saving tokens.

What *does* exist: unit coverage against the **fake** upstream, in
`tests/proxyInject.test.ts` — a realistic compact Claude Code body with nested
`tool_reference` blocks, asserted byte-stable outside `system`
(`"realistic compact Claude Code body with nested tool_reference injects
successfully"`, plus the `tools`-array preservation cases). `inject.ts`'s
round-trip guard means any body it cannot reproduce byte-for-byte is forwarded
unmodified. That is a strong argument. It is not a live observation.

**To close it**, against `https://api.anthropic.com` with a real Anthropic key
and a real Claude model:

1. `klio init` (or set `ENABLE_TOOL_SEARCH=true` and `ANTHROPIC_BASE_URL`
   at the proxy) and run one real Claude Code turn with several MCP servers
   connected, so the request genuinely carries `tool_reference` blocks.
2. Compare `usage.input_tokens` for the same turn direct vs proxied. A
   ~85% jump in tool-schema tokens through the proxy is the failure signature.
3. Confirm the request Anthropic received still contained `type:
   "tool_reference"` entries — e.g. by asserting the model can still call a
   tool that was only ever offered by reference.

Until someone runs that, treat tool-schema savings through the proxy as
unproven.

### Cancelled uploads over 10 MB

Documented at length in `src/proxy/server.ts` (the `KNOWN LIMITATION` block
above `BufferedThenLive`) and **not re-tested here**. In summary: a client that
disappears mid-upload on the over-cap (>10 MB) path is not detected, and the
upstream request is not torn down — the remaining body keeps being relayed at
the upstream's pace. Measured previously against real sockets: a backpressured
upstream kept relaying for 30.5 s and delivered 12.5 MB on behalf of a dead
client; a deaf upstream was not released at all within 120 s, bounded in
practice only by Node's 300 s default `server.requestTimeout`. Three fixes were
built and measured, and all three cost more than they saved; see that comment
for why there is deliberately no idle timer, probe, or abort.

### Other gaps in this run

* **Anthropic itself was never contacted.** Rate-limit headers
  (`anthropic-ratelimit-*`), `anthropic-beta` handling, overloaded/529
  behaviour, and Anthropic's own SSE ping cadence are unobserved.
* **Codex / `/v1/responses` is untested live.** By design it is forwarded byte
  for byte with no injection or capture (`upstream.path.endsWith("/messages")`
  gates both), but no real `/v1/responses` request was sent.
* **The >10 MB over-cap path itself** was not exercised against this real
  upstream at all — no >10 MB body was sent.
* **The launchd supervisor was not exercised.** Check 6 drove `klio proxy
  ensure` directly; the real `tech.klio.proxy` agent was deliberately left
  alone, so "launchd restarts a dead proxy on this machine" remains covered
  only by the unit suite and the plist's own contents.
* **Two literals were patched** in the built artifact under test (port,
  upstream host) for §1–§7 only. §8 ran the unpatched build on the new
  `--port` / `--upstream` seams; §1–§7 were not re-run on them.

---

## Machine state after the run

Every process started by this verification was killed; ports 18787 and 18788
are free. The user's real supervised proxy answered on 8787 with the **same
pid, 87493**, before and after.

SHA-256, before → after:

| File | Before | After |
|---|---|---|
| `~/.klio/config.json` | `713683aa…` | `713683aa…` unchanged |
| `~/.claude/settings.json` | `25869d7b…` | `25869d7b…` unchanged |
| `~/Library/LaunchAgents/tech.klio.proxy.plist` | `c127f7a6…` | `c127f7a6…` unchanged |
| `~/.klio/proxy-wiring.json` | `5a1bdc22…` | `5a1bdc22…` unchanged |
| `~/.claude.json` | `a6a8f8cc…` | `11ac59fe…` **changed** |

`~/.claude.json` is Claude Code's own live session store, rewritten
continuously by the CLI session that performed this verification. Nothing in
this run wrote to it, and no Klio command that touches it was executed
(`klio init`, `klio uninit`, `installSupervisor`/`uninstallSupervisor` were
never run, and `launchctl` was never invoked).

---

## Reproducing this

```bash
cd npm && npm run build

# Point HOME at a throwaway dir holding its own .klio/config.json, then
# run the real CLI on an unused port against whichever upstream you want.
# No patched literals, no copy of the build.
HOME=$TMPHOME node bin/klio.mjs proxy serve \
  --port 18787 --upstream https://litellm.oppla.dev &
curl -s http://127.0.0.1:18787/__klio/health
```

Against Anthropic proper, drop `--upstream` and supply an Anthropic key.

To watch warming rather than a single request, send the same question twice with
a ~10 s gap and read `x-klio-injected` / `x-klio-injected-reason` on each:
`cold` then `hit`, with neither request paying the recall latency.
