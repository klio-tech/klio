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
  close: () => Promise<void>;
  setMemories: (fn: (query: string) => { id: string; content: string }[]) => void;
  setStatus: (status: number) => void;
};

async function startEngine(opts: EngineOptions = {}): Promise<FakeEngine> {
  const delayMs = opts.delayMs ?? SLOW_RECALL_MS;
  let status = opts.status ?? 200;
  let memoriesFor = opts.memories ?? ((q: string) => [{ id: "m1", content: `memory for ${q}` }]);
  const calls: string[] = [];
  const timers = new Set<NodeJS.Timeout>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let query = "";
      try {
        query = String((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { query?: string }).query ?? "");
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

async function turn(base: string, text: string): Promise<Turn> {
  const started = Date.now();
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: text }] }),
  });
  await res.text();
  return {
    elapsedMs: Date.now() - started,
    injected: Number(res.headers.get("x-klio-injected") ?? "-1"),
    reason: res.headers.get(INJECT_REASON_HEADER),
  };
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
// D. The reason header, in each of its cases
// ---------------------------------------------------------------------

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
