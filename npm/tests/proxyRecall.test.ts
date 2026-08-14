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

test("a never-resolving, signal-ignoring fetchImpl times out at the budget", async () => {
  const recall = createRecaller({
    config: CONFIG,
    budgetMs: 50,
    fetchImpl: ((_u: any, _init: any) =>
      new Promise((_resolve, _reject) => {
        // Never resolves, never checks signal
      })) as unknown as typeof fetch,
  });
  const started = Date.now();
  const out = await recall("hanging");
  const elapsed = Date.now() - started;
  assert.deepEqual(out, []);
  assert.ok(elapsed < 150, `must return within ~budget (elapsed ${elapsed}ms > 150ms)`);
});

test("the cache cap evicts oldest entries when exceeded", async () => {
  const calls: string[] = [];
  const recall = createRecaller({
    config: CONFIG,
    fetchImpl: okFetch([{ id: "m1", content: "c" }], calls) as unknown as typeof fetch,
  });
  // Prime the cache with 256 queries
  for (let i = 0; i < 256; i++) {
    await recall(`query-${i}`);
  }
  const callsAfterPrime = calls.length;
  // Verify all 256 are cached by querying them again
  for (let i = 0; i < 256; i++) {
    await recall(`query-${i}`);
  }
  assert.equal(calls.length, callsAfterPrime, "all 256 queries must be cached");
  // Add one more query (257th), which should evict the oldest (query-0)
  await recall(`query-256`);
  // Verify newest entry (query-256) is still cached
  const callsBeforeNewest = calls.length;
  await recall(`query-256`);
  assert.equal(calls.length, callsBeforeNewest, "newest entry must survive eviction");
  // Verify oldest entry was evicted
  await recall(`query-0`);
  assert.ok(calls.length > callsBeforeNewest, "oldest entry must be evicted when cap is exceeded");
});

test("no timer outlives a successful recall call", async () => {
  const recall = createRecaller({
    config: CONFIG,
    budgetMs: 5000,
    fetchImpl: (async () => new Response(JSON.stringify({ memories: [{ id: "m1", content: "c" }] }), { status: 200 })) as unknown as typeof fetch,
  });
  const resourcesBefore = process.getActiveResourcesInfo?.() ?? [];
  const timeoutsBefore = resourcesBefore.filter((r) => r === "Timeout").length;
  await recall("quick");
  const resourcesAfter = process.getActiveResourcesInfo?.() ?? [];
  const timeoutsAfter = resourcesAfter.filter((r) => r === "Timeout").length;
  assert.equal(timeoutsAfter, timeoutsBefore, "no timeout timer should outlive the recall call");
});
