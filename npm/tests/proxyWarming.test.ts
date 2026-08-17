// Background warming, and the reason header that makes it visible.
//
// EVERY test in this file drives a recall endpoint that is DELIBERATELY
// SLOW (6s by default — the latency production actually exhibits). That
// is the whole point. The defect these tests exist for shipped past
// seven green suites precisely because every stand-in answered in
// microseconds, where a 300ms request-path budget is never exceeded and
// "the request path waits for recall" and "the request path reads a
// cache" are indistinguishable.
//
// So: a fake upstream and a fake engine, but never a FAST one.

import { strict as assert } from "node:assert";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { INJECT_REASON_HEADER, createWarmingRecaller, type WarmingRecaller } from "../src/proxy/recall.js";
import { createProxyServer } from "../src/proxy/server.js";

/** Production-representative recall latency. See the module docblock. */
const SLOW_RECALL_MS = 6_000;

/** A request that waits on a 6s recall cannot come in under this. */
const NON_BLOCKING_MS = 1_000;

/** Distinctive enough that "did this leak into a log line?" is answerable. */
const API_KEY = "klio-test-key-must-never-be-logged";

type EngineOptions = {
  delayMs?: number;
  status?: number;
  memories?: (query: string) => { id: string; content: string }[];
};

type FakeEngine = {
  base: string;
  calls: string[];
  /** Full parsed request bodies, in order — for asserting on `repo_root`/`git_remote`. */
  bodies: Record<string, unknown>[];
  close: () => Promise<void>;
  setMemories: (fn: (query: string) => { id: string; content: string }[]) => void;
  setStatus: (status: number) => void;
};

async function startEngine(opts: EngineOptions = {}): Promise<FakeEngine> {
  const delayMs = opts.delayMs ?? SLOW_RECALL_MS;
  let status = opts.status ?? 200;
  let memoriesFor = opts.memories ?? ((q: string) => [{ id: "m1", content: `memory for ${q}` }]);
  const calls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const timers = new Set<NodeJS.Timeout>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let query = "";
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        query = String(parsed.query ?? "");
        bodies.push(parsed);
      } catch {
        query = "";
      }
      calls.push(query);
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (res.destroyed) return;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ memories: status === 200 ? memoriesFor(query) : [] }));
      }, delayMs);
      timers.add(timer);
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    bodies,
    setMemories: (fn) => { memoriesFor = fn; },
    setStatus: (s) => { status = s; },
    close: async () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

type Harness = {
  proxyBase: string;
  engine: FakeEngine;
  recaller: WarmingRecaller;
  /** What the upstream saw in `system` on the most recent request. */
  lastSystem: () => unknown;
};

type HarnessOptions = {
  engine?: EngineOptions;
  ambient?: boolean;
  ambientIntervalMs?: number;
  ttlMs?: number;
  budgetMs?: number;
  inject?: boolean;
  withConfig?: boolean;
  log?: (line: string) => void;
  /** The project this harness's recaller should be scoped to, if any. */
  project?: { repo_root?: string; git_remote?: string };
};

async function withWarmingProxy(opts: HarnessOptions, run: (h: Harness) => Promise<void>): Promise<void> {
  const engine = await startEngine(opts.engine);

  let lastSystem: unknown = undefined;
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        lastSystem = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { system?: unknown }).system;
      } catch {
        lastSystem = undefined;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const config = { apiKey: API_KEY, agentId: "a", baseUrl: engine.base };
  const recaller = createWarmingRecaller({
    config,
    ambient: opts.ambient ?? false,
    ambientIntervalMs: opts.ambientIntervalMs,
    ttlMs: opts.ttlMs,
    budgetMs: opts.budgetMs,
    log: opts.log ?? (() => {}),
    project: opts.project,
  });
  recaller.start();

  const proxy = createProxyServer({
    config: opts.withConfig === false ? null : config,
    inject: opts.inject,
    recall: recaller.lookup,
    upstreams: { anthropic: `http://127.0.0.1:${upstreamPort}` },
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const { port } = proxy.address() as AddressInfo;

  try {
    await run({
      proxyBase: `http://127.0.0.1:${port}`,
      engine,
      recaller,
      lastSystem: () => lastSystem,
    });
  } finally {
    recaller.stop();
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await new Promise<void>((r) => proxy.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
    await engine.close();
  }
}

type Turn = { elapsedMs: number; injected: number; reason: string | null };

async function turnWith(base: string, messages: unknown[]): Promise<Turn> {
  const started = Date.now();
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages }),
  });
  await res.text();
  return {
    elapsedMs: Date.now() - started,
    injected: Number(res.headers.get("x-klio-injected") ?? "-1"),
    reason: res.headers.get(INJECT_REASON_HEADER),
  };
}

async function turn(base: string, text: string): Promise<Turn> {
  return turnWith(base, [{ role: "user", content: text }]);
}

/** What a Claude Code tool iteration actually looks like on the wire. */
function toolLoop(question: string, iterations: number): unknown[] {
  const messages: unknown[] = [{ role: "user", content: question }];
  for (let i = 0; i < iterations; i++) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `tu_${i}`, name: "Read", input: { file: `f${i}.ts` } }],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `tu_${i}`, content: `contents of f${i}.ts` }],
    });
  }
  return messages;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------
// A. The request path never waits on the network
// ---------------------------------------------------------------------

test("a 6s recall never delays the request path, and a later turn is warm", async () => {
  await withWarmingProxy({}, async (h) => {
    const first = await turn(h.proxyBase, "why postgres");
    assert.ok(
      first.elapsedMs < NON_BLOCKING_MS,
      `first turn must not wait on recall (took ${first.elapsedMs}ms)`,
    );
    assert.equal(first.injected, 0);
    assert.equal(first.reason, "cold");

    // The background fetch is in flight. Wait for it OUT of the request
    // path, then repeat the same query.
    await h.recaller.idle();

    const second = await turn(h.proxyBase, "why postgres");
    assert.equal(second.injected, 1, "the second turn must hit a warm cache");
    assert.equal(second.reason, "hit");
    assert.ok(
      second.elapsedMs < NON_BLOCKING_MS,
      `a warm turn must not wait either (took ${second.elapsedMs}ms)`,
    );
    assert.ok(JSON.stringify(h.lastSystem()).includes("memory for why postgres"));
  });
});

// ---------------------------------------------------------------------
// B. Single flight
// ---------------------------------------------------------------------

test("N concurrent misses for one query produce exactly one upstream recall", async () => {
  await withWarmingProxy({}, async (h) => {
    const turns = await Promise.all(
      Array.from({ length: 20 }, () => turn(h.proxyBase, "stampede")),
    );
    for (const t of turns) {
      assert.ok(t.elapsedMs < NON_BLOCKING_MS, `every concurrent turn must return fast (${t.elapsedMs}ms)`);
    }
    await h.recaller.idle();
    const forQuery = h.engine.calls.filter((q) => q === "stampede");
    assert.equal(forQuery.length, 1, `expected exactly one upstream recall, saw ${forQuery.length}`);
  });
});

// ---------------------------------------------------------------------
// C. Ambient warm set
// ---------------------------------------------------------------------

test("the ambient warm set injects on the first request of a never-seen query", async () => {
  await withWarmingProxy(
    { ambient: true, engine: { memories: () => [{ id: "a1", content: "ambient org context" }] } },
    async (h) => {
      await h.recaller.idle(); // the startup ambient fetch

      const first = await turn(h.proxyBase, "a query nobody has ever asked before");
      assert.equal(first.injected, 1, "the ambient set must cover the very first turn");
      assert.equal(first.reason, "ambient");
      assert.ok(first.elapsedMs < NON_BLOCKING_MS);
      assert.ok(JSON.stringify(h.lastSystem()).includes("ambient org context"));
    },
  );
});

// ---------------------------------------------------------------------
// C2. The agent loop — where most real requests live
// ---------------------------------------------------------------------

test("tool_result turns keep injecting, from the question that started the loop", async () => {
  // A Claude Code tool iteration sends the WHOLE conversation back with
  // a `tool_result`-only user turn on the end. Reading "the last user
  // message" literally makes the query empty on every one of those, so
  // injection went inert for the majority of turns in the primary use
  // case — and the `system` block flipped between two shapes inside one
  // loop, paying prompt-cache invalidation for context it never got.
  await withWarmingProxy({}, async (h) => {
    const question = "why did we choose postgres";
    assert.equal((await turn(h.proxyBase, question)).reason, "cold");
    await h.recaller.idle();

    const opening = await turn(h.proxyBase, question);
    assert.equal(opening.reason, "hit");
    assert.equal(opening.injected, 1);

    for (let i = 1; i <= 4; i++) {
      const t = await turnWith(h.proxyBase, toolLoop(question, i));
      assert.equal(t.reason, "hit", `tool iteration ${i} must still inject`);
      assert.equal(t.injected, 1, `tool iteration ${i} must carry the same memories`);
      assert.ok(t.elapsedMs < NON_BLOCKING_MS);
      assert.ok(
        JSON.stringify(h.lastSystem()).includes(`memory for ${question}`),
        `tool iteration ${i} must carry the ORIGINATING question's memories`,
      );
    }

    // The engine saw the query once, not once per tool iteration.
    const forQuestion = h.engine.calls.filter((q) => q === question);
    assert.equal(forQuestion.length, 1);
  });
});

test("a conversation with no user text anywhere is still no-query", async () => {
  await withWarmingProxy({ ambient: false }, async (h) => {
    const t = await turnWith(h.proxyBase, [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_0", content: "output" }] },
    ]);
    assert.equal(t.injected, 0);
    assert.equal(t.reason, "no-query", "genuinely queryless is a different thing from a tool turn");
  });
});

// ---------------------------------------------------------------------
// D. The reason header, in each of its cases
// ---------------------------------------------------------------------

test("reason: malformed-body when the body is not JSON at all", async () => {
  await withWarmingProxy({}, async (h) => {
    const res = await fetch(`${h.proxyBase}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json at all",
    });
    await res.text();
    assert.equal(res.headers.get("x-klio-injected"), "0");
    assert.equal(
      res.headers.get(INJECT_REASON_HEADER),
      "malformed-body",
      "an unparseable body is a different fact from 'injection could never apply here'",
    );
  });
});

test("reason: disabled when injection is switched off", async () => {
  await withWarmingProxy({ inject: false }, async (h) => {
    const t = await turn(h.proxyBase, "q");
    assert.equal(t.injected, 0);
    assert.equal(t.reason, "disabled");
  });
});

test("reason: no-config when the machine holds no cloud config", async () => {
  await withWarmingProxy({ withConfig: false }, async (h) => {
    const t = await turn(h.proxyBase, "q");
    assert.equal(t.injected, 0);
    assert.equal(t.reason, "no-config");
  });
});

test("reason: not-applicable for a request injection could never apply to", async () => {
  await withWarmingProxy({}, async (h) => {
    const res = await fetch(`${h.proxyBase}/v1/models`);
    await res.text();
    assert.equal(res.headers.get("x-klio-injected"), "0");
    assert.equal(res.headers.get(INJECT_REASON_HEADER), "not-applicable");
  });
});

test("reason: empty when the engine answers with no memories", async () => {
  await withWarmingProxy({ engine: { memories: () => [] } }, async (h) => {
    assert.equal((await turn(h.proxyBase, "nothing known")).reason, "cold");
    await h.recaller.idle();
    const second = await turn(h.proxyBase, "nothing known");
    assert.equal(second.injected, 0);
    assert.equal(second.reason, "empty", "an answered-but-empty recall must not read as cold");
  });
});

// The engine now applies a relevance floor and can legitimately return
// zero memories for a query that later gets a real answer — e.g. because
// the org's memory grew, or the floor's judgment call was query-
// dependent. An `empty` verdict must be a FRESHNESS-BOUNDED cache entry,
// not a standing "never ask again": once it goes stale it is refetched
// like any other entry (see recall.ts's stale-while-revalidate
// invariant), and a query that now has a real answer gets it — nothing
// from the earlier empty result leaks forward and suppresses it.
test("an empty recall does not permanently suppress a later good result", async () => {
  await withWarmingProxy(
    { engine: { memories: () => [] }, ttlMs: 50 },
    async (h) => {
      assert.equal((await turn(h.proxyBase, "grows an answer")).reason, "cold");
      await h.recaller.idle();

      const second = await turn(h.proxyBase, "grows an answer");
      assert.equal(second.injected, 0);
      assert.equal(second.reason, "empty");

      // The org's memory grew: the same query now has a real answer.
      h.engine.setMemories(() => [{ id: "m1", content: "now known" }]);

      // Past the (short, test-only) TTL, the stale-but-served empty entry
      // triggers a background refresh — same mechanism as any other stale
      // entry, no special-casing for "empty" needed or present.
      await sleep(100);
      const third = await turn(h.proxyBase, "grows an answer");
      assert.equal(third.reason, "empty", "the stale entry is still served while the refresh runs");
      await h.recaller.idle();

      const fourth = await turn(h.proxyBase, "grows an answer");
      assert.equal(fourth.injected, 1, "the refreshed entry must carry the now-real answer");
      assert.equal(fourth.reason, "hit");
    },
  );
});

test("reason: error, and one log line, when the background recall fails", async () => {
  const logged: string[] = [];
  await withWarmingProxy(
    { engine: { status: 500 }, log: (l) => logged.push(l) },
    async (h) => {
      assert.equal((await turn(h.proxyBase, "boom")).reason, "cold");
      await h.recaller.idle();
      const second = await turn(h.proxyBase, "boom");
      assert.equal(second.injected, 0);
      assert.equal(second.reason, "error");
      assert.ok(logged.length >= 1, "an error must not be silent");
      assert.ok(logged.some((l) => l.includes("recall")));
      // No query text, no memory content, no credentials.
      assert.ok(!logged.some((l) => l.includes("boom")), "the query must never be logged");
      assert.ok(!logged.some((l) => l.includes(API_KEY)), "the key must never be logged");
    },
  );
});

test("reason: error, and the request still succeeds, when recall times out", async () => {
  await withWarmingProxy({ budgetMs: 300, engine: { delayMs: SLOW_RECALL_MS } }, async (h) => {
    const first = await turn(h.proxyBase, "too slow for the background budget");
    assert.equal(first.reason, "cold");
    await h.recaller.idle();
    const second = await turn(h.proxyBase, "too slow for the background budget");
    assert.equal(second.injected, 0);
    assert.equal(second.reason, "error");
    assert.ok(second.elapsedMs < NON_BLOCKING_MS);
  });
});

// ---------------------------------------------------------------------
// E. Cache discipline
// ---------------------------------------------------------------------

test("a stale entry is served immediately while a refresh runs behind it", async () => {
  await withWarmingProxy({ ttlMs: 1 }, async (h) => {
    await turn(h.proxyBase, "evolving");
    await h.recaller.idle();
    assert.equal((await turn(h.proxyBase, "evolving")).injected, 1);

    h.engine.setMemories(() => [
      { id: "n1", content: "fresher one" },
      { id: "n2", content: "fresher two" },
    ]);

    // Stale (ttl 1ms) — must still answer from the cache, instantly.
    const stale = await turn(h.proxyBase, "evolving");
    assert.equal(stale.injected, 1, "a stale entry is served, never dropped");
    assert.equal(stale.reason, "hit");
    assert.ok(stale.elapsedMs < NON_BLOCKING_MS);

    await h.recaller.idle();
    const refreshed = await turn(h.proxyBase, "evolving");
    assert.equal(refreshed.injected, 2, "the refresh behind it must have landed");
  });
});

test("the cache is bounded at 256 entries, oldest out, ambient never evicted", async () => {
  await withWarmingProxy(
    { ambient: true, engine: { delayMs: 0 } },
    async (h) => {
      await h.recaller.idle();
      assert.equal(h.recaller.lookup("unseen").reason, "ambient", "ambient is warm");

      for (let i = 0; i < 300; i++) {
        h.recaller.lookup(`q-${i}`);
        await h.recaller.idle();
      }
      assert.equal(h.recaller.size(), 256, `cache must stay capped (saw ${h.recaller.size()})`);
      assert.equal(h.recaller.lookup("q-299").reason, "hit", "the newest entry survives");
      assert.equal(h.recaller.lookup("q-0").reason, "ambient", "the oldest was evicted");

      // The ambient entry must never be the eviction victim, or the
      // first turn of every session goes cold forever.
      h.recaller.stop();
      assert.equal(h.recaller.lookup("still-unseen").reason, "ambient");
    },
  );
});

// ---------------------------------------------------------------------
// F. Timers
// ---------------------------------------------------------------------

// The strict "no `Timeout` resource outlives the call" assertion lives
// in tests/proxyRecall.test.ts, where a stubbed fetch means the process
// holds no sockets and the count is deterministic. Here — with three
// real HTTP servers and their per-connection keep-alive timers coming
// and going — a process-wide count is noise, so the same property is
// asserted behaviourally instead: after `stop()`, the refresh interval
// must stop producing work.
test("the ambient refresh interval does not outlive stop()", async () => {
  await withWarmingProxy({ ambient: true, ambientIntervalMs: 50, engine: { delayMs: 0 } }, async (h) => {
    await h.recaller.idle();
    await sleep(200); // several interval periods
    const whileRunning = h.engine.calls.length;
    assert.ok(whileRunning >= 2, `the interval must actually be firing (saw ${whileRunning} calls)`);

    h.recaller.stop();
    await h.recaller.idle();
    // A fetch already on the wire when `stop()` was called can still be
    // recorded by the engine a moment later — that is the last one, not
    // a new one. Let it land before sampling, or this test measures the
    // race rather than the interval.
    await sleep(100);
    const atStop = h.engine.calls.length;
    await sleep(300); // six more interval periods
    assert.equal(h.engine.calls.length, atStop, "a stopped warmer must never fire again");
  });
});

test("a hung engine's socket is released at the budget, not leaked", async () => {
  // The unit-level proof is in tests/proxyRecall.test.ts (the abort
  // signal fires). This is the consequence, on a real socket: an engine
  // that accepts the connection and never answers must not cost one
  // permanently-open socket per timed-out miss.
  const sockets: import("node:net").Socket[] = [];
  const hung = http.createServer(() => {
    // Accept the request and never respond. Never.
  });
  hung.on("connection", (s) => sockets.push(s));
  await new Promise<void>((r) => hung.listen(0, "127.0.0.1", r));
  const hungPort = (hung.address() as AddressInfo).port;

  const recaller = createWarmingRecaller({
    config: { apiKey: API_KEY, agentId: "a", baseUrl: `http://127.0.0.1:${hungPort}` },
    ambient: false,
    log: () => {},
    budgetMs: 300,
    fetchImpl: undefined, // the REAL global fetch, on a REAL socket
  });

  try {
    recaller.lookup("a query the engine will never answer");
    await recaller.idle();

    // Poll rather than assert instantly: the abort has to propagate
    // through undici to the socket.
    //
    // `some`, not `every`: undici's pool legitimately holds an extra
    // idle connection open that never carried this request (confirmed
    // against a bare `http.Server` — one aborted fetch leaves 2 server
    // sockets, 1 destroyed). What must be released is the one carrying
    // the abandoned request, and with no abort NOTHING is released.
    let closed = false;
    for (let i = 0; i < 40 && !closed; i++) {
      closed = sockets.some((s) => s.destroyed);
      if (!closed) await sleep(50);
    }
    assert.ok(sockets.length > 0, "the engine must actually have been dialled");
    assert.ok(closed, `the abandoned request's socket must be released (${sockets.length} sockets, none destroyed)`);
  } finally {
    recaller.stop();
    hung.closeAllConnections();
    await new Promise<void>((r) => hung.close(() => r()));
  }
});

test("stop() aborts a background recall that is still in flight", async () => {
  await withWarmingProxy({}, async (h) => {
    await turn(h.proxyBase, "in flight when we stop"); // 6s engine, now pending
    const started = Date.now();
    h.recaller.stop();
    await h.recaller.idle();
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < NON_BLOCKING_MS,
      `stop() must abort in-flight work, not wait it out (took ${elapsed}ms)`,
    );
  });
});

test("a stopped recaller starts no new work", async () => {
  await withWarmingProxy({}, async (h) => {
    h.recaller.stop();
    const callsBefore = h.engine.calls.length;
    const t = await turn(h.proxyBase, "after stop");
    assert.equal(t.injected, 0);
    await sleep(100);
    assert.equal(h.engine.calls.length, callsBefore, "a stopped recaller must not fetch");
  });
});

// ---------------------------------------------------------------------
// G. Project scoping — the proxy sends `repo_root`/`git_remote` end to
// end, on the wire the engine actually sees.
// ---------------------------------------------------------------------

test("a resolved project is sent as repo_root/git_remote on the recall request", async () => {
  await withWarmingProxy(
    { project: { repo_root: "/repo/klio", git_remote: "git@github.com:klio-tech/klio.git" } },
    async (h) => {
      await turn(h.proxyBase, "why postgres");
      await h.recaller.idle();
      assert.equal(h.engine.bodies.length, 1);
      assert.equal(h.engine.bodies[0]!.repo_root, "/repo/klio");
      assert.equal(h.engine.bodies[0]!.git_remote, "git@github.com:klio-tech/klio.git");
    },
  );
});

test("no project resolved sends neither field — fail-open, unscoped recall", async () => {
  await withWarmingProxy({}, async (h) => {
    await turn(h.proxyBase, "why postgres");
    await h.recaller.idle();
    assert.equal(h.engine.bodies.length, 1);
    assert.ok(!("repo_root" in h.engine.bodies[0]!), "no repo_root when no project was resolved");
    assert.ok(!("git_remote" in h.engine.bodies[0]!), "no git_remote when no project was resolved");
  });
});
