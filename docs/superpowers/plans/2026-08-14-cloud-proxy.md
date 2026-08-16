# Cloud Proxy (Node) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Node proxy inside the existing CLI that injects Klio memory into model requests and captures sessions back — giving Cloud users the injection point that today requires Docker, and closing the evidence loop for agents that cannot run hooks.

**Architecture:** A `node:http` server forwards requests to the provider verbatim, with one narrow exception: `POST` to a messages endpoint gets its `system` field appended with recalled memories, and after the response is forwarded, the conversation is emitted to `/capture/transcript`. A process-based supervisor strategy revives it without Docker; `initCloud` offers it and wires Claude Code and Codex.

**Tech Stack:** TypeScript, `node:http`, Node 20 global `fetch`, `node:test` + `tsx`. **Zero new runtime dependencies.**

## Global Constraints

- **The npm package has ZERO runtime dependencies** (`"dependencies": []`). Do not add any. Use `node:http` for the server and Node 20's global `fetch` for the upstream leg; stream with `Readable.fromWeb(res.body)`. Adding a dep changes `npx` install time for every user.
- **Tests:** `node --test --import tsx 'tests/**/*.test.ts'`, run with `npm test` from `npm/`. Follow `tests/hook.test.ts`: every seam (config, fetch, clock) injected, so the suite never touches the network or real filesystem.
- **Do not break `tool_reference` blocks.** Never read, rewrite, or reorder `tools`, `tool_choice`, or `messages`. Injection appends to `system` and nothing else. Breaking this costs ~85% on tool schemas silently.
- **Fail open, always.** Parse failure, recall failure, timeout, oversize body, unexpected shape → forward the original bytes unchanged. There is no path where the agent's request fails to reach the model because of Klio.
- **Recall budget: hard 300 ms.** Late answer → no injection, request already sent.
- **Loopback only.** `PROXY_HOST` is `127.0.0.1`; the proxy forwards the user's provider credentials, so a network-reachable proxy is an open relay.
- **Existing constants are the contract:** `PROXY_PORT = 8787`, `PROXY_BASE_URL = http://localhost:8787`, `PROXY_SERVICE = "proxy"`, health at `GET /__klio/health`, named upstreams at `/__klio/upstream/<name>`.
- **Existing supervisor surface is unchanged:** `detectSupervisor`, `supervisorPaths`, `renderLaunchAgent`, `renderSystemdUnit`, `probeProxy`, `CHECK_INTERVAL_SECONDS = 60`, and `klio proxy ensure` exit codes (`0` answering, `1` could not fix).
- **Cloud config is the credential source:** `readCloudConfig()` → `{ apiKey, agentId, baseUrl }`; returns `null` when no key. No key → no injection, no capture, pure pass-through.
- **Env kill switches:** `KLIO_PROXY_INJECT=off`, `KLIO_PROXY_CAPTURE=off`. Capture is off whenever injection is off.
- The Python proxy and `init --local` are untouched by this plan.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `npm/src/proxy/headers.ts` | Hop-by-hop deny list + header filtering, ported from `proxy/src/klio_proxy/headers.py` |
| `npm/src/proxy/inject.ts` | Pure body transform: append recalled memories to `system`. No I/O. |
| `npm/src/proxy/recall.ts` | Klio recall client with the 300 ms budget and the 60 s cache |
| `npm/src/proxy/capture.ts` | Fire-and-forget emit of the conversation to `/capture/transcript` |
| `npm/src/proxy/server.ts` | The HTTP server: routing, verbatim forwarding, streaming, wiring the three above |
| `npm/src/proxy/processSupervisor.ts` | Spawn/PID-file revive strategy (the Docker-free half of `ensure`) |
| `npm/src/commands/proxy.ts` | Add the `serve` subcommand (existing file) |
| `npm/src/commands/initCloud.ts` | Offer the proxy, default no; wire Claude Code + Codex (existing file) |

---

### Task 1: Header filtering

**Files:**
- Create: `npm/src/proxy/headers.ts`
- Test: `npm/tests/proxyHeaders.test.ts`

**Interfaces:**
- Produces: `HOP_BY_HOP: ReadonlySet<string>`, `filterRequestHeaders(h: Record<string,string|string[]|undefined>): Record<string,string>`, `filterResponseHeaders(h: Headers): Record<string,string>`.

Port the deny list from `proxy/src/klio_proxy/headers.py` — a **deny** list, never an allow list, so a header Anthropic adds tomorrow survives today's code.

- [ ] **Step 1: Write the failing test**

```ts
// npm/tests/proxyHeaders.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { filterRequestHeaders, filterResponseHeaders, HOP_BY_HOP } from "../src/proxy/headers.js";

test("hop-by-hop headers are dropped from requests", () => {
  const out = filterRequestHeaders({
    "x-api-key": "sk-abc",
    "content-type": "application/json",
    connection: "keep-alive",
    "transfer-encoding": "chunked",
    "keep-alive": "timeout=5",
    host: "localhost:8787",
  });
  assert.equal(out["x-api-key"], "sk-abc");
  assert.equal(out["content-type"], "application/json");
  for (const dropped of ["connection", "transfer-encoding", "keep-alive", "host"]) {
    assert.equal(out[dropped], undefined, `${dropped} must not be forwarded`);
  }
});

test("unknown headers survive — deny list, not allow list", () => {
  const out = filterRequestHeaders({ "anthropic-beta": "tools-2026", "x-brand-new": "1" });
  assert.equal(out["anthropic-beta"], "tools-2026");
  assert.equal(out["x-brand-new"], "1");
});

test("rate-limit and retry headers reach the client", () => {
  const h = new Headers({
    "anthropic-ratelimit-requests-remaining": "42",
    "retry-after": "3",
    "request-id": "req_1",
    connection: "close",
  });
  const out = filterResponseHeaders(h);
  assert.equal(out["anthropic-ratelimit-requests-remaining"], "42");
  assert.equal(out["retry-after"], "3");
  assert.equal(out["request-id"], "req_1");
  assert.equal(out["connection"], undefined);
});

test("array-valued request headers collapse to the first value", () => {
  const out = filterRequestHeaders({ "x-multi": ["a", "b"] });
  assert.equal(out["x-multi"], "a");
});

test("the deny list is lowercase and includes the RFC set", () => {
  for (const name of ["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authenticate", "proxy-authorization"]) {
    assert.ok(HOP_BY_HOP.has(name), `${name} missing from deny list`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd npm && npm test 2>&1 | grep -A3 proxyHeaders`
Expected: FAIL — cannot resolve `../src/proxy/headers.js`.

- [ ] **Step 3: Write the implementation**

```ts
// npm/src/proxy/headers.ts
// Header filtering for the local proxy, ported from
// proxy/src/klio_proxy/headers.py.
//
// A DENY list, never an allow list. An allow list silently drops the
// header Anthropic adds next month; a deny list forwards it. The cost
// of forwarding one header we did not anticipate is nothing; the cost
// of dropping `anthropic-ratelimit-*` is an agent that cannot back off.

/** Connection-scoped headers that must not cross a proxy hop (RFC 9110). */
export const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection", // non-standard but widely emitted
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Headers meaningful only to the hop the client opened. `host` must be
 * recomputed for the upstream; `content-length` is recomputed because
 * injection can change the body length.
 */
const REQUEST_ONLY_DROPS: ReadonlySet<string> = new Set(["host", "content-length"]);

export function filterRequestHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lowered = name.toLowerCase();
    if (HOP_BY_HOP.has(lowered) || REQUEST_ONLY_DROPS.has(lowered)) continue;
    out[lowered] = Array.isArray(value) ? (value[0] ?? "") : value;
  }
  return out;
}

export function filterResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lowered = name.toLowerCase();
    // content-length is dropped: the body is streamed, and a stale
    // length on a re-chunked response is worse than none.
    if (HOP_BY_HOP.has(lowered) || lowered === "content-length") return;
    out[lowered] = value;
  });
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd npm && npm test 2>&1 | grep -A3 proxyHeaders`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add npm/src/proxy/headers.ts npm/tests/proxyHeaders.test.ts
git commit -m "feat(proxy): header filtering — deny list ported from the Python proxy"
```

---

### Task 2: The injection transform

**Files:**
- Create: `npm/src/proxy/inject.ts`
- Test: `npm/tests/proxyInject.test.ts`

**Interfaces:**
- Produces: `type Memory = { id: string; content: string }`, `injectMemories(bodyBytes: Buffer, memories: Memory[]): { body: Buffer; injected: number }`.
- Pure — no I/O, no async. Returns the ORIGINAL buffer with `injected: 0` on any doubt.

This is where `tool_reference` safety lives. Append one block to `system`; touch nothing else; verify by round-trip before returning.

- [ ] **Step 1: Write the failing test**

```ts
// npm/tests/proxyInject.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { injectMemories } from "../src/proxy/inject.js";

const MEMS = [
  { id: "m1", content: "Tenant isolation moved to the application layer." },
  { id: "m2", content: "p95 must stay under 200ms." },
];

test("a string system prompt is promoted to an array, original first", () => {
  const body = Buffer.from(JSON.stringify({ model: "claude", system: "You are helpful.", messages: [] }));
  const { body: out, injected } = injectMemories(body, MEMS);
  const parsed = JSON.parse(out.toString());
  assert.equal(injected, 2);
  assert.ok(Array.isArray(parsed.system));
  assert.equal(parsed.system[0].text, "You are helpful.");
  assert.match(parsed.system[1].text, /Tenant isolation/);
});

test("an array system prompt is appended to, never reordered", () => {
  const body = Buffer.from(JSON.stringify({
    system: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
    messages: [],
  }));
  const parsed = JSON.parse(injectMemories(body, MEMS).body.toString());
  assert.equal(parsed.system[0].text, "first");
  assert.equal(parsed.system[1].text, "second");
  assert.equal(parsed.system.length, 3);
});

test("tools and messages are byte-identical after injection", () => {
  const original = {
    system: "s",
    tools: [{ type: "tool_reference", name: "Bash" }, { name: "Edit", input_schema: { a: 1 } }],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };
  const out = JSON.parse(injectMemories(Buffer.from(JSON.stringify(original)), MEMS).body.toString());
  assert.deepEqual(out.tools, original.tools, "tools must be untouched");
  assert.deepEqual(out.tool_choice, original.tool_choice);
  assert.deepEqual(out.messages, original.messages);
});

test("no memories means the original buffer, unchanged", () => {
  const body = Buffer.from(JSON.stringify({ system: "s", messages: [] }));
  const { body: out, injected } = injectMemories(body, []);
  assert.equal(injected, 0);
  assert.equal(out.toString(), body.toString());
});

test("unparseable body is forwarded verbatim", () => {
  const body = Buffer.from("not json at all");
  const { body: out, injected } = injectMemories(body, MEMS);
  assert.equal(injected, 0);
  assert.equal(out.toString(), "not json at all");
});

test("a body with no system key gains one", () => {
  const body = Buffer.from(JSON.stringify({ model: "claude", messages: [] }));
  const parsed = JSON.parse(injectMemories(body, MEMS).body.toString());
  assert.ok(Array.isArray(parsed.system));
  assert.equal(parsed.system.length, 1);
});

test("a non-string, non-array system is left alone entirely", () => {
  const body = Buffer.from(JSON.stringify({ system: 42, messages: [] }));
  const { body: out, injected } = injectMemories(body, MEMS);
  assert.equal(injected, 0);
  assert.equal(out.toString(), body.toString());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd npm && npm test 2>&1 | grep -A3 proxyInject`
Expected: FAIL — cannot resolve `../src/proxy/inject.js`.

- [ ] **Step 3: Write the implementation**

```ts
// npm/src/proxy/inject.ts
// The one transform this proxy applies: append recalled memories to the
// request's `system` field.
//
// The constraint that binds here is NOT "never parse bodies" — that
// described how the pass-through stage achieved its guarantee. What
// binds is: DO NOT BREAK `tool_reference` BLOCKS. Pointing
// ANTHROPIC_BASE_URL at a non-Anthropic host disables MCP Tool Search;
// `klio init` re-enables it, and that only works if tool_reference
// blocks survive the hop. Getting it wrong costs ~85% on tool schemas
// SILENTLY, while Klio claims to be saving tokens.
//
// So this function reads `system` and nothing else, appends and never
// reorders, and verifies by round-trip that every other top-level key
// is untouched before returning a mutated body. On any doubt it returns
// the original bytes.

export type Memory = { id: string; content: string };

export type InjectResult = { body: Buffer; injected: number };

/** Header/label the model sees above injected context. */
const PREAMBLE = "Team context from Klio (shared memory — treat as established fact):";

function renderBlock(memories: Memory[]): string {
  const lines = memories.map((m) => `- ${m.content}`);
  return `${PREAMBLE}\n${lines.join("\n")}`;
}

export function injectMemories(bodyBytes: Buffer, memories: Memory[]): InjectResult {
  const unchanged: InjectResult = { body: bodyBytes, injected: 0 };
  if (memories.length === 0) return unchanged;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyBytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    return unchanged; // not JSON — forward verbatim
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return unchanged;

  const system = parsed["system"];
  const block = { type: "text", text: renderBlock(memories) };

  let nextSystem: unknown;
  if (system === undefined) {
    nextSystem = [block];
  } else if (typeof system === "string") {
    // Promote to the array form, original FIRST so the agent's own
    // instructions keep precedence in the model's reading order.
    nextSystem = [{ type: "text", text: system }, block];
  } else if (Array.isArray(system)) {
    nextSystem = [...system, block];
  } else {
    // Some shape we do not understand. Do not guess.
    return unchanged;
  }

  const mutated = { ...parsed, system: nextSystem };
  let serialized: Buffer;
  try {
    serialized = Buffer.from(JSON.stringify(mutated), "utf8");
  } catch {
    return unchanged;
  }

  // Round-trip check: every top-level key except `system` must survive
  // byte-for-byte in meaning. This is what makes it safe to have parsed
  // at all — tools, tool_choice and messages are proven untouched.
  try {
    const reparsed = JSON.parse(serialized.toString("utf8")) as Record<string, unknown>;
    for (const key of Object.keys(parsed)) {
      if (key === "system") continue;
      if (JSON.stringify(reparsed[key]) !== JSON.stringify(parsed[key])) return unchanged;
    }
  } catch {
    return unchanged;
  }

  return { body: serialized, injected: memories.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd npm && npm test 2>&1 | grep -A3 proxyInject`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add npm/src/proxy/inject.ts npm/tests/proxyInject.test.ts
git commit -m "feat(proxy): system-prompt injection that provably leaves tools untouched"
```

---

### Task 3: Recall client — budget and cache

**Files:**
- Create: `npm/src/proxy/recall.ts`
- Test: `npm/tests/proxyRecall.test.ts`

**Interfaces:**
- Produces: `createRecaller(opts: { config: CloudConfig; fetchImpl?: typeof fetch; now?: () => number; budgetMs?: number; ttlMs?: number }): (query: string) => Promise<Memory[]>`.
- Consumes: `Memory` (Task 2); `CloudConfig` from `../cloudConfig.js` (`{ apiKey, agentId, baseUrl }`).
- Never throws. Returns `[]` on timeout, non-2xx, network error, or bad shape.

- [ ] **Step 1: Write the failing test**

```ts
// npm/tests/proxyRecall.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createRecaller } from "../src/proxy/recall.js";

const CONFIG = { apiKey: "k", agentId: "a", baseUrl: "https://api.example" };

function okFetch(memories: unknown[], calls: string[] = []) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ memories }), { status: 200 });
  };
}

test("returns memories and sends the key + agent headers", async () => {
  let seen: Record<string, string> = {};
  const recall = createRecaller({
    config: CONFIG,
    fetchImpl: (async (_u: any, init: any) => {
      seen = init.headers;
      return new Response(JSON.stringify({ memories: [{ id: "m1", content: "c" }] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const out = await recall("why postgres");
  assert.equal(out.length, 1);
  assert.equal(seen["X-Vex-Key"], "k");
  assert.equal(seen["X-Vex-Agent"], "a");
});

test("a slow recall is abandoned at the budget and yields nothing", async () => {
  const recall = createRecaller({
    config: CONFIG,
    budgetMs: 20,
    fetchImpl: ((_u: any, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch,
  });
  const started = Date.now();
  const out = await recall("slow");
  assert.deepEqual(out, []);
  assert.ok(Date.now() - started < 200, "must not wait beyond the budget");
});

test("a non-2xx response yields nothing, never throws", async () => {
  const recall = createRecaller({
    config: CONFIG,
    fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
  });
  assert.deepEqual(await recall("q"), []);
});

test("a network error yields nothing, never throws", async () => {
  const recall = createRecaller({
    config: CONFIG,
    fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
  });
  assert.deepEqual(await recall("q"), []);
});

test("identical queries inside the TTL hit the cache once", async () => {
  const calls: string[] = [];
  const recall = createRecaller({
    config: CONFIG,
    ttlMs: 60_000,
    now: () => 1_000,
    fetchImpl: okFetch([{ id: "m1", content: "c" }], calls) as unknown as typeof fetch,
  });
  await recall("same");
  await recall("same");
  assert.equal(calls.length, 1, "second identical query must be served from cache");
});

test("the cache expires after the TTL", async () => {
  const calls: string[] = [];
  let clock = 1_000;
  const recall = createRecaller({
    config: CONFIG,
    ttlMs: 100,
    now: () => clock,
    fetchImpl: okFetch([{ id: "m1", content: "c" }], calls) as unknown as typeof fetch,
  });
  await recall("same");
  clock += 500;
  await recall("same");
  assert.equal(calls.length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd npm && npm test 2>&1 | grep -A3 proxyRecall`
Expected: FAIL — cannot resolve `../src/proxy/recall.js`.

- [ ] **Step 3: Write the implementation**

```ts
// npm/src/proxy/recall.ts
// Recall client for the proxy's injection path.
//
// Two properties matter more than completeness:
//   * It NEVER throws. A recall problem must degrade to "no injection",
//     never to a failed model call.
//   * It NEVER exceeds its budget. This runs inline before the user's
//     request is forwarded; a slow Klio must not become a slow agent.

import type { CloudConfig } from "../cloudConfig.js";
import type { Memory } from "./inject.js";

const DEFAULT_BUDGET_MS = 300;
const DEFAULT_TTL_MS = 60_000;
const RECALL_LIMIT = 8;

export type RecallerOptions = {
  config: CloudConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
  budgetMs?: number;
  ttlMs?: number;
};

type CacheEntry = { at: number; memories: Memory[] };

export function createRecaller(opts: RecallerOptions): (query: string) => Promise<Memory[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  return async function recall(query: string): Promise<Memory[]> {
    if (!query.trim() || !opts.config.apiKey) return [];

    const cached = cache.get(query);
    if (cached && now() - cached.at < ttlMs) return cached.memories;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    try {
      const res = await doFetch(`${opts.config.baseUrl}/capture/recall`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Vex-Key": opts.config.apiKey,
          "X-Vex-Agent": opts.config.agentId,
        },
        body: JSON.stringify({ query, limit: RECALL_LIMIT, scope: "org" }),
        signal: controller.signal,
      });
      if (!res.ok) return [];
      const payload = (await res.json()) as { memories?: unknown };
      const raw = Array.isArray(payload.memories) ? payload.memories : [];
      const memories: Memory[] = raw
        .map((r) => r as Record<string, unknown>)
        .filter((r) => typeof r["content"] === "string" && (r["content"] as string).trim() !== "")
        .map((r) => ({ id: String(r["id"] ?? ""), content: String(r["content"]) }));
      cache.set(query, { at: now(), memories });
      return memories;
    } catch {
      // Timeout, abort, network failure, malformed JSON — all the same
      // answer: no injection this turn.
      return [];
    } finally {
      clearTimeout(timer);
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd npm && npm test 2>&1 | grep -A3 proxyRecall`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add npm/src/proxy/recall.ts npm/tests/proxyRecall.test.ts
git commit -m "feat(proxy): recall client with a 300ms budget and a 60s cache"
```

---

### Task 4: Capture emitter

**Files:**
- Create: `npm/src/proxy/capture.ts`
- Test: `npm/tests/proxyCapture.test.ts`

**Interfaces:**
- Produces: `conversationSessionId(agent: string, messages: unknown[]): string`, `emitCapture(opts: { config: CloudConfig; agent: string; requestBody: Buffer; assistantText: string; fetchImpl?: typeof fetch }): Promise<void>`.
- Consumes: `CloudConfig`.
- Never throws, never awaited by the response path.

The session id is derived from the FIRST user message so every turn of one conversation shares an id — the richer-transcript-wins upsert in the engine then keeps the fullest version.

- [ ] **Step 1: Write the failing test**

```ts
// npm/tests/proxyCapture.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { conversationSessionId, emitCapture } from "../src/proxy/capture.js";

const CONFIG = { apiKey: "k", agentId: "a", baseUrl: "https://api.example" };

const body = (msgs: unknown[]) => Buffer.from(JSON.stringify({ messages: msgs }));

test("session id is stable across turns of one conversation", () => {
  const first = [{ role: "user", content: "start the auth refactor" }];
  const later = [...first, { role: "assistant", content: "ok" }, { role: "user", content: "next" }];
  assert.equal(conversationSessionId("codex", first), conversationSessionId("codex", later));
});

test("different conversations get different ids", () => {
  assert.notEqual(
    conversationSessionId("codex", [{ role: "user", content: "A" }]),
    conversationSessionId("codex", [{ role: "user", content: "B" }]),
  );
});

test("session id is namespaced to the proxy and the agent", () => {
  assert.match(conversationSessionId("codex", [{ role: "user", content: "A" }]), /^klio-proxy:codex:/);
});

test("emit posts the transcript with auth headers", async () => {
  let seenUrl = "";
  let seenBody: any = null;
  let seenHeaders: any = null;
  await emitCapture({
    config: CONFIG,
    agent: "codex",
    requestBody: body([{ role: "user", content: "why postgres" }]),
    assistantText: "because of tenant isolation",
    fetchImpl: (async (url: any, init: any) => {
      seenUrl = String(url);
      seenHeaders = init.headers;
      seenBody = JSON.parse(init.body);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.match(seenUrl, /\/capture\/transcript$/);
  assert.equal(seenHeaders["X-Vex-Key"], "k");
  assert.equal(seenBody.messages.at(-1).role, "assistant");
  assert.equal(seenBody.messages.at(-1).content, "because of tenant isolation");
  assert.match(seenBody.session_id, /^klio-proxy:codex:/);
});

test("a failing emit never throws", async () => {
  await emitCapture({
    config: CONFIG,
    agent: "codex",
    requestBody: body([{ role: "user", content: "q" }]),
    assistantText: "a",
    fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch,
  });
  // reaching here without throwing is the assertion
  assert.ok(true);
});

test("an unparseable request body is skipped silently", async () => {
  let called = false;
  await emitCapture({
    config: CONFIG,
    agent: "codex",
    requestBody: Buffer.from("nonsense"),
    assistantText: "a",
    fetchImpl: (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch,
  });
  assert.equal(called, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd npm && npm test 2>&1 | grep -A3 proxyCapture`
Expected: FAIL — cannot resolve `../src/proxy/capture.js`.

- [ ] **Step 3: Write the implementation**

```ts
// npm/src/proxy/capture.ts
// Emit a proxied conversation to the engine so agents WITHOUT hook
// support still feed the evidence loop.
//
// Capture lives in bridge/internal/hooks today, which reaches only
// harnesses that support hooks — in practice Claude Code. Codex and any
// self-built agent write memories through MCP and are never retained,
// graded, or attributed. The proxy sees the whole conversation, so it is
// the one place their sessions can be captured.
//
// Strictly after the response is forwarded, strictly fire-and-forget.

import { createHash } from "node:crypto";

import type { CloudConfig } from "../cloudConfig.js";

/**
 * Derive a session id from the conversation's FIRST user message, so
 * every turn of one conversation shares an id. The engine's
 * richer-transcript-wins upsert then keeps the fullest version rather
 * than fragmenting one session into forty rows.
 */
export function conversationSessionId(agent: string, messages: unknown[]): string {
  const firstUser = messages.find(
    (m) => (m as Record<string, unknown> | null)?.["role"] === "user",
  ) as Record<string, unknown> | undefined;
  const seed = firstUser ? JSON.stringify(firstUser["content"] ?? "") : "empty";
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 16);
  return `klio-proxy:${agent}:${hash}`;
}

/** Flatten Anthropic content (string or block array) to plain text. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b as Record<string, unknown>)?.["text"])
    .filter((t): t is string => typeof t === "string")
    .join("\n");
}

export type EmitCaptureOptions = {
  config: CloudConfig;
  agent: string;
  requestBody: Buffer;
  assistantText: string;
  fetchImpl?: typeof fetch;
};

export async function emitCapture(opts: EmitCaptureOptions): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    if (!opts.config.apiKey) return;

    const parsed = JSON.parse(opts.requestBody.toString("utf8")) as Record<string, unknown>;
    const rawMessages = Array.isArray(parsed["messages"]) ? (parsed["messages"] as unknown[]) : [];
    if (rawMessages.length === 0) return;

    const messages = rawMessages.map((m) => {
      const r = m as Record<string, unknown>;
      return { role: String(r["role"] ?? "user"), content: textOf(r["content"]) };
    });
    if (opts.assistantText.trim() !== "") {
      messages.push({ role: "assistant", content: opts.assistantText });
    }

    await doFetch(`${opts.config.baseUrl}/capture/transcript`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vex-Key": opts.config.apiKey,
        "X-Vex-Agent": opts.config.agentId,
      },
      body: JSON.stringify({
        session_id: conversationSessionId(opts.agent, rawMessages),
        messages,
        tool_calls: [],
      }),
    });
  } catch {
    // Best-effort by contract. A capture failure must never surface to
    // the agent, whose response has already been delivered.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd npm && npm test 2>&1 | grep -A3 proxyCapture`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add npm/src/proxy/capture.ts npm/tests/proxyCapture.test.ts
git commit -m "feat(proxy): capture proxied sessions so hookless agents feed the loop"
```

---

### Task 5: The server

**Files:**
- Create: `npm/src/proxy/server.ts`
- Test: `npm/tests/proxyServer.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: `createProxyServer(opts: { config: CloudConfig | null; upstreams?: Record<string,string>; recall?: (q: string) => Promise<Memory[]>; capture?: typeof emitCapture; fetchImpl?: typeof fetch; inject?: boolean; captureEnabled?: boolean }): http.Server`, and `startProxy(opts): Promise<{ server: http.Server; port: number }>`.

Behaviour: `GET /__klio/health` → `{"status":"ok"}`. `/__klio/upstream/<name>/...` selects a named upstream and strips the prefix. Everything else forwards to the default upstream verbatim. Only `POST` whose path ends `/messages` is parsed for injection. Responses stream via `Readable.fromWeb`. Every response carries `x-klio-injected`.

- [ ] **Step 1: Write the failing test**

```ts
// npm/tests/proxyServer.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AddressInfo } from "node:net";

import { createProxyServer } from "../src/proxy/server.js";

const CONFIG = { apiKey: "k", agentId: "a", baseUrl: "https://api.example" };

async function withServer(
  opts: Parameters<typeof createProxyServer>[0],
  run: (base: string) => Promise<void>,
) {
  const server = createProxyServer(opts);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("health responds without touching upstream", async () => {
  await withServer(
    { config: CONFIG, fetchImpl: (async () => { throw new Error("upstream must not be called"); }) as any },
    async (base) => {
      const res = await fetch(`${base}/__klio/health`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).status, "ok");
    },
  );
});

test("a non-messages request is forwarded verbatim with its status", async () => {
  let seenUrl = "";
  await withServer(
    {
      config: CONFIG,
      inject: false,
      fetchImpl: (async (url: any) => {
        seenUrl = String(url);
        return new Response("upstream-body", { status: 418, headers: { "x-custom": "kept" } });
      }) as any,
    },
    async (base) => {
      const res = await fetch(`${base}/v1/models`);
      assert.equal(res.status, 418);
      assert.equal(res.headers.get("x-custom"), "kept");
      assert.equal(await res.text(), "upstream-body");
      assert.match(seenUrl, /api\.anthropic\.com\/v1\/models$/);
    },
  );
});

test("a messages POST is injected and reports the count", async () => {
  let forwarded: any = null;
  await withServer(
    {
      config: CONFIG,
      recall: async () => [{ id: "m1", content: "remembered thing" }],
      fetchImpl: (async (_u: any, init: any) => {
        forwarded = JSON.parse(init.body.toString());
        return new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }] }), { status: 200 });
      }) as any,
    },
    async (base) => {
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ system: "base", messages: [{ role: "user", content: "q" }] }),
      });
      assert.equal(res.headers.get("x-klio-injected"), "1");
      assert.ok(JSON.stringify(forwarded.system).includes("remembered thing"));
    },
  );
});

test("a recall failure still forwards the request, injected 0", async () => {
  await withServer(
    {
      config: CONFIG,
      recall: async () => { throw new Error("recall exploded"); },
      fetchImpl: (async () => new Response("{}", { status: 200 })) as any,
    },
    async (base) => {
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "q" }] }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-klio-injected"), "0");
    },
  );
});

test("an unreachable upstream returns 502 with the error header, never hangs", async () => {
  await withServer(
    {
      config: CONFIG,
      inject: false,
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as any,
    },
    async (base) => {
      const res = await fetch(`${base}/v1/messages`, { method: "POST", body: "{}" });
      assert.equal(res.status, 502);
      assert.ok(res.headers.get("x-klio-proxy-error"));
      assert.equal((await res.json()).type, "error");
    },
  );
});

test("the upstream prefix selects a named upstream and is stripped", async () => {
  let seenUrl = "";
  await withServer(
    {
      config: CONFIG,
      inject: false,
      fetchImpl: (async (url: any) => { seenUrl = String(url); return new Response("ok"); }) as any,
    },
    async (base) => {
      await fetch(`${base}/__klio/upstream/openai/v1/chat/completions`, { method: "POST", body: "{}" });
      assert.equal(seenUrl, "https://api.openai.com/v1/chat/completions");
    },
  );
});

test("capture fires after the response, with the assistant text", async () => {
  let captured: any = null;
  await withServer(
    {
      config: CONFIG,
      recall: async () => [],
      captureEnabled: true,
      capture: (async (o: any) => { captured = o; }) as any,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ content: [{ type: "text", text: "the answer" }] }), { status: 200 })) as any,
    },
    async (base) => {
      await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "q" }] }),
      });
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(captured, "capture should have been invoked");
      assert.equal(captured.assistantText, "the answer");
    },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd npm && npm test 2>&1 | grep -A3 proxyServer`
Expected: FAIL — cannot resolve `../src/proxy/server.js`.

- [ ] **Step 3: Write the implementation**

Implement `npm/src/proxy/server.ts` with `node:http`:

- `createProxyServer(opts)` returns an `http.Server` whose handler:
  1. `GET /__klio/health` → 200 `{"status":"ok"}`, never touching upstream.
  2. Resolve the upstream: if the path starts `/__klio/upstream/<name>/`, look `<name>` up in `upstreams` (default map `{ anthropic: "https://api.anthropic.com", openai: "https://api.openai.com" }`) and strip the prefix; otherwise use `anthropic`.
  3. Buffer the request body (`for await (const chunk of req)`), capped at 10 MB — above the cap, forward the raw stream with no injection.
  4. If `opts.inject !== false`, the method is `POST`, the resolved path ends with `/messages`, and `opts.config` is non-null: derive the query from the last `user` message's text, `await recall(query)` inside a `try/catch` that yields `[]`, then `injectMemories`.
  5. `fetchImpl(upstreamUrl, { method, headers: filterRequestHeaders(req.headers), body, duplex: "half" })` inside `try/catch`. On throw: 502, `x-klio-proxy-error: <message>`, body `{"type":"error","error":{"type":"api_error","message":...}}`.
  6. Write status + `filterResponseHeaders(res.headers)` + `x-klio-injected: <n>`, then stream: `Readable.fromWeb(upstream.body).pipe(nodeRes)`.
  7. When `captureEnabled` and injection ran, tee the response text and call `capture({...})` **without awaiting** — after `nodeRes.end()`.
- `startProxy(opts)` reads `PROXY_PORT`/`PROXY_HOST` from `./constants.js`, honours `KLIO_PROXY_INJECT` / `KLIO_PROXY_CAPTURE`, loads config via `readCloudConfig()`, builds a recaller with `createRecaller`, and listens.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd npm && npm test 2>&1 | grep -A3 proxyServer`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add npm/src/proxy/server.ts npm/tests/proxyServer.test.ts
git commit -m "feat(proxy): Node server — verbatim forwarding, injection, streaming, capture"
```

---

### Task 6: `proxy serve` + process supervisor

**Files:**
- Create: `npm/src/proxy/processSupervisor.ts`
- Modify: `npm/src/commands/proxy.ts`
- Test: `npm/tests/proxyProcess.test.ts`

**Interfaces:**
- Produces: `pidFilePath(home?: string): string`, `isProxyRunning(pid: number, killImpl?: (p: number, s: number) => void): boolean`, `spawnProxy(opts: { cliPath: string; spawnImpl?: typeof spawn; writeFileImpl?: (p: string, d: string) => void }): number`.
- `runProxyCommand` gains `serve` (foreground, calls `startProxy`) and its `ensure` gains the process strategy when cloud mode is active.

- [ ] **Step 1: Write the failing test**

```ts
// npm/tests/proxyProcess.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { isProxyRunning, pidFilePath, spawnProxy } from "../src/proxy/processSupervisor.js";

test("pid file lives beside the other klio state", () => {
  assert.match(pidFilePath("/home/x"), /^\/home\/x\/\.klio\/proxy\.pid$/);
});

test("a live pid reports running", () => {
  assert.equal(isProxyRunning(123, () => {}), true);
});

test("a dead pid reports not running", () => {
  assert.equal(isProxyRunning(123, () => { throw new Error("ESRCH"); }), false);
});

test("spawn is detached, unref'd, and records the pid", () => {
  let seenArgs: string[] = [];
  let seenOpts: any = null;
  let written = "";
  const pid = spawnProxy({
    cliPath: "/tmp/cli.js",
    spawnImpl: ((_cmd: string, args: string[], o: any) => {
      seenArgs = args;
      seenOpts = o;
      return { pid: 4242, unref() {} } as any;
    }) as any,
    writeFileImpl: (_p, d) => { written = d; },
  });
  assert.equal(pid, 4242);
  assert.deepEqual(seenArgs, ["/tmp/cli.js", "proxy", "serve"]);
  assert.equal(seenOpts.detached, true);
  assert.equal(written, "4242");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd npm && npm test 2>&1 | grep -A3 proxyProcess`
Expected: FAIL — cannot resolve `../src/proxy/processSupervisor.js`.

- [ ] **Step 3: Write the implementation**

```ts
// npm/src/proxy/processSupervisor.ts
// The Docker-free half of `klio proxy ensure`.
//
// Local mode revives the proxy with `docker compose up -d proxy`. Cloud
// mode has no compose file and no daemon, so it spawns the CLI's own
// `proxy serve` detached and remembers the pid. `ensure`'s contract is
// unchanged either way: probe first, revive only on failure, exit 0 when
// the proxy answers and 1 when it cannot be fixed.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function pidFilePath(home: string = homedir()): string {
  return join(home, ".klio", "proxy.pid");
}

/** Signal 0 tests for existence without delivering a signal. */
export function isProxyRunning(
  pid: number,
  killImpl: (p: number, s: number) => void = process.kill.bind(process),
): boolean {
  try {
    killImpl(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type SpawnProxyOptions = {
  cliPath: string;
  spawnImpl?: typeof spawn;
  writeFileImpl?: (path: string, data: string) => void;
  home?: string;
};

export function spawnProxy(opts: SpawnProxyOptions): number {
  const doSpawn = opts.spawnImpl ?? spawn;
  const write = opts.writeFileImpl ?? ((p: string, d: string) => writeFileSync(p, d, "utf8"));
  // Detached + unref so the proxy outlives the `ensure` invocation that
  // started it — the supervisor fires every 60s and must not hold it.
  const child = doSpawn(process.execPath, [opts.cliPath, "proxy", "serve"], {
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid ?? 0;
  child.unref();
  write(pidFilePath(opts.home), String(pid));
  return pid;
}
```

Then in `npm/src/commands/proxy.ts`: add a `serve` case that awaits `startProxy({})` and never returns; and in `ensure`, when cloud mode is active (no compose file / cloud config present), call `spawnProxy` instead of `composeUpService`, preserving the exit codes.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd npm && npm test 2>&1 | grep -A3 proxyProcess`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add npm/src/proxy/processSupervisor.ts npm/src/commands/proxy.ts npm/tests/proxyProcess.test.ts
git commit -m "feat(proxy): proxy serve + docker-free process supervisor"
```

---

### Task 7: `initCloud` offers the proxy

**Files:**
- Modify: `npm/src/commands/initCloud.ts`
- Test: `npm/tests/initCloudProxy.test.ts`

**Interfaces:**
- Consumes: `wireProxy` from `../proxy/wiring.js` (wires Claude Code AND Codex), `installSupervisor` from `../proxy/supervisor.js`, `spawnProxy` (Task 6).
- The prompt defaults to **no**. Shown only when Claude Code or Codex is detected.

- [ ] **Step 1: Write the failing test**

```ts
// npm/tests/initCloudProxy.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { maybeOfferProxy } from "../src/commands/initCloud.js";

test("bare Enter declines — the default is no", async () => {
  let wired = false;
  const result = await maybeOfferProxy({
    ask: async () => "",
    anyProxyableAgent: true,
    wire: async () => { wired = true; },
  });
  assert.equal(result.enabled, false);
  assert.equal(wired, false);
});

test("an explicit yes wires the proxy", async () => {
  let wired = false;
  const result = await maybeOfferProxy({
    ask: async () => "y",
    anyProxyableAgent: true,
    wire: async () => { wired = true; },
  });
  assert.equal(result.enabled, true);
  assert.equal(wired, true);
});

test("no proxyable agent means no prompt at all", async () => {
  let asked = false;
  const result = await maybeOfferProxy({
    ask: async () => { asked = true; return "y"; },
    anyProxyableAgent: false,
    wire: async () => {},
  });
  assert.equal(asked, false);
  assert.equal(result.enabled, false);
});

test("a wiring failure is reported, not thrown", async () => {
  const result = await maybeOfferProxy({
    ask: async () => "y",
    anyProxyableAgent: true,
    wire: async () => { throw new Error("settings.json is read-only"); },
  });
  assert.equal(result.enabled, false);
  assert.match(result.error ?? "", /read-only/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd npm && npm test 2>&1 | grep -A3 initCloudProxy`
Expected: FAIL — `maybeOfferProxy` is not exported.

- [ ] **Step 3: Write the implementation**

Export from `initCloud.ts`:

```ts
export type OfferProxyOptions = {
  ask: (prompt: string) => Promise<string>;
  anyProxyableAgent: boolean;
  wire: () => Promise<void>;
};

export type OfferProxyResult = { enabled: boolean; error?: string };

/**
 * Offer the local proxy, defaulting to NO.
 *
 * Pointing ANTHROPIC_BASE_URL at localhost is the most invasive thing
 * this tool does to a machine — every model call an agent makes goes
 * through a process we installed. A Cloud user signed up precisely to
 * avoid running things. So this is opt-in, and a bare Enter declines.
 */
export async function maybeOfferProxy(opts: OfferProxyOptions): Promise<OfferProxyResult> {
  if (!opts.anyProxyableAgent) return { enabled: false };
  const answer = (
    await opts.ask(
      "Route model calls through a local Klio proxy? It injects your team's\n" +
        "context into every request and captures sessions for grading, even in\n" +
        "agents without hook support. Runs on 127.0.0.1 and fails open. [y/N]: ",
    )
  ).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") return { enabled: false };
  try {
    await opts.wire();
    return { enabled: true };
  } catch (err) {
    return { enabled: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

Call it from the cloud flow after agent wiring, passing `anyProxyableAgent` = "Claude Code or Codex was detected", and a `wire` that calls `wireProxy(...)`, `installSupervisor(...)`, and `spawnProxy(...)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd npm && npm test 2>&1 | grep -A3 initCloudProxy`
Expected: PASS, 4 tests.

- [ ] **Step 5: Full suite, lint, commit**

```bash
cd npm && npm test && npm run lint
git add npm/src/commands/initCloud.ts npm/tests/initCloudProxy.test.ts
git commit -m "feat(init): offer the local proxy on the cloud path, default no"
```

---

### Task 8: Live verification against the real API

**Files:**
- Create: `npm/docs/proxy-manual-verification.md`

Unit tests use a fake upstream. This proves it against Anthropic for real, once, by hand.

- [ ] **Step 1: Start the proxy and check health**

```bash
cd npm && npm run build
node dist/index.js proxy serve &
curl -s http://127.0.0.1:8787/__klio/health
```
Expected: `{"status":"ok"}`

- [ ] **Step 2: Verbatim pass-through with a real key**

```bash
curl -s -D- -o /tmp/direct.json https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":16,"messages":[{"role":"user","content":"say ok"}]}'

curl -s -D- -o /tmp/proxied.json http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":16,"messages":[{"role":"user","content":"say ok"}]}'

diff <(jq -S 'del(.id)' /tmp/direct.json) <(jq -S 'del(.id)' /tmp/proxied.json) && echo "IDENTICAL"
```
Expected: `IDENTICAL`, and the proxied response carries `x-klio-injected`.

- [ ] **Step 3: Streaming is not buffered**

```bash
curl -N -s http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"count to twenty slowly"}]}' \
  | head -5
```
Expected: `event:`/`data:` lines appear progressively, not all at once after a pause.

- [ ] **Step 4: Injection reaches the model**

```bash
curl -s http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":120,"messages":[{"role":"user","content":"What do you know about this team from Klio context?"}]}' \
  | jq -r '.content[0].text'
```
Expected: the answer references real memories from the org — proof the injected `system` block reached the model.

- [ ] **Step 5: Capture landed**

```sql
-- NOT `LIKE 'klio-proxy:%'` — that matches NOTHING. The engine
-- namespaces the id it is given, storing
-- `klio-hook:<org_id>:u:<user_id>:klio-proxy:<agent>:<hash>`, so the
-- proxy's own prefix is in the MIDDLE of the stored value. Anyone
-- running the anchored form would conclude, wrongly, that proxy capture
-- is broken. Confirmed against the production database on 2026-08-15.
SELECT session_id, message_count FROM session_traces
 WHERE session_id LIKE '%klio-proxy:%' ORDER BY created_at DESC LIMIT 3;
```
Expected: at least one row from the calls above.

- [ ] **Step 6: Kill it and confirm the supervisor revives it**

```bash
kill $(cat ~/.klio/proxy.pid)
node dist/index.js proxy ensure; echo "exit=$?"
curl -s http://127.0.0.1:8787/__klio/health
```
Expected: `exit=0` and health answers again.

- [ ] **Step 7: Write the results into the doc and commit**

```bash
git add npm/docs/proxy-manual-verification.md
git commit -m "docs(proxy): manual verification against the real API"
```

---

## Deployment notes

- Ships in the CLI: bump `npm/package.json` in the release PR, or the publish workflow will skip (it compares the local version against npm — a source-only change publishes nothing and still reports success).
- No new env required for pass-through. Injection and capture activate only when `~/.klio/cloud.json` holds a key.
- Kill switches: `KLIO_PROXY_INJECT=off`, `KLIO_PROXY_CAPTURE=off`.
- `klio uninit` already unwires the proxy; no change needed.

## Out of scope

- Compression in the seam.
- Converting the local Docker stack to this Node proxy (the Python container stays; convergence is a deliberate follow-up).
- Agents without a base-URL override — Cursor routes most models through its own backend; hosted agents (claude.ai, ChatGPT) can never be proxied.
