// Unit-level contract of the warming recaller.
//
// The BEHAVIOUR that matters — that the request path never waits, that
// warming actually warms, that a stampede collapses to one fetch — is
// driven end to end through a real proxy against a deliberately SLOW
// recall endpoint in tests/proxyWarming.test.ts, and against the real
// engine in docs/proxy-manual-verification.md. What is left here is the
// wire contract and the fail-open guarantees, where a fast stub is the
// right tool.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { AMBIENT_QUERY, cacheKeyFor, createWarmingRecaller } from "../src/proxy/recall.js";

const CONFIG = { apiKey: "k", agentId: "a", baseUrl: "https://api.example" };

function okFetch(memories: unknown[], calls: string[] = []) {
  return async (url: string | URL | Request, _init?: RequestInit) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ memories }), { status: 200 });
  };
}

/** Build a recaller, warm one query, and hand back the lookup. */
async function warmed(opts: Parameters<typeof createWarmingRecaller>[0], query: string) {
  const recaller = createWarmingRecaller({ ambient: false, log: () => {}, ...opts });
  recaller.lookup(query);
  await recaller.idle();
  return recaller;
}

test("sends the key + agent headers, and the documented body", async () => {
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  let seenBody: Record<string, unknown> = {};
  const recaller = await warmed(
    {
      config: CONFIG,
      fetchImpl: (async (u: any, init: any) => {
        seenUrl = String(u);
        seenHeaders = init.headers;
        seenBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ memories: [{ id: "m1", content: "c" }] }), { status: 200 });
      }) as unknown as typeof fetch,
    },
    "why postgres",
  );

  assert.equal(seenUrl, "https://api.example/capture/recall");
  assert.equal(seenHeaders["X-Vex-Key"], "k");
  assert.equal(seenHeaders["X-Vex-Agent"], "a");
  assert.deepEqual(seenBody, { query: "why postgres", limit: 8, scope: "org" });

  const out = recaller.lookup("why postgres");
  assert.equal(out.memories.length, 1);
  assert.equal(out.reason, "hit");
  recaller.stop();
});

// ---------------------------------------------------------------------
// Project scoping — vex_engine PR #33 fences recall to the caller's
// project via `repo_root`/`git_remote`. These are additive and,
// deliberately, ONE VALUE FOR THE WHOLE RECALLER (see
// RecallerOptions.project): a proxy resolves its project once at
// startup, not per request.
// ---------------------------------------------------------------------

test("sends repo_root and git_remote when a project is resolved", async () => {
  let seenBody: Record<string, unknown> = {};
  const recaller = await warmed(
    {
      config: CONFIG,
      project: { repo_root: "/repo/klio", git_remote: "git@github.com:klio-tech/klio.git" },
      fetchImpl: (async (_u: any, init: any) => {
        seenBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ memories: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    },
    "why postgres",
  );
  assert.deepEqual(seenBody, {
    query: "why postgres",
    limit: 8,
    scope: "org",
    repo_root: "/repo/klio",
    git_remote: "git@github.com:klio-tech/klio.git",
  });
  recaller.stop();
});

test("no project resolved sends neither field — fail-open, unscoped recall", async () => {
  let seenBody: Record<string, unknown> = {};
  const recaller = await warmed(
    {
      config: CONFIG,
      fetchImpl: (async (_u: any, init: any) => {
        seenBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ memories: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    },
    "why postgres",
  );
  assert.deepEqual(seenBody, { query: "why postgres", limit: 8, scope: "org" });
  assert.ok(!("repo_root" in seenBody));
  assert.ok(!("git_remote" in seenBody));
  recaller.stop();
});

test("a partial project (repo_root only, no remote) sends just that field", async () => {
  let seenBody: Record<string, unknown> = {};
  const recaller = await warmed(
    {
      config: CONFIG,
      project: { repo_root: "/repo/klio" },
      fetchImpl: (async (_u: any, init: any) => {
        seenBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ memories: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    },
    "q",
  );
  assert.equal(seenBody.repo_root, "/repo/klio");
  assert.ok(!("git_remote" in seenBody));
  recaller.stop();
});

test("cacheKeyFor: the same query under two different projects produces different keys", () => {
  const a = cacheKeyFor({ repo_root: "/repo/a" }, "why postgres");
  const b = cacheKeyFor({ repo_root: "/repo/b" }, "why postgres");
  const unscoped = cacheKeyFor(undefined, "why postgres");
  assert.notEqual(a, b, "two different projects must not share a key");
  assert.notEqual(a, unscoped, "a scoped query must not collide with the unscoped key");
  assert.notEqual(b, unscoped);
});

test("cacheKeyFor: an unresolved project collapses to the pre-scoping (unscoped) key", () => {
  // `{}` (no repo_root, no git_remote — e.g. resolveProject's fail-open
  // case for a non-git cwd) must key identically to `undefined`, not
  // introduce a THIRD distinct "empty project" bucket.
  assert.equal(cacheKeyFor({}, "q"), cacheKeyFor(undefined, "q"));
  assert.equal(cacheKeyFor(undefined, "q"), "q");
});

test("cacheKeyFor: repo_root alone, git_remote alone, and both together are three distinct keys", () => {
  // Broader coverage than the two-project comparison above: every shape
  // ResolvedProject can actually take must produce its own key, not
  // just "any two projects I happened to pick differ".
  const repoOnly = cacheKeyFor({ repo_root: "/repo/a" }, "q");
  const remoteOnly = cacheKeyFor({ git_remote: "git@github.com:o/a.git" }, "q");
  const both = cacheKeyFor({ repo_root: "/repo/a", git_remote: "git@github.com:o/a.git" }, "q");
  const unscoped = cacheKeyFor(undefined, "q");
  const keys = [repoOnly, remoteOnly, both, unscoped];
  assert.equal(new Set(keys).size, keys.length, `all four must be distinct, got ${JSON.stringify(keys)}`);
});

// A BEHAVIOURAL counterpart to the cacheKeyFor unit tests above, driven
// through `lookup()` rather than the pure function directly.
//
// HONEST LIMIT ON WHAT THIS CAN PROVE: `project` is fixed per
// `WarmingRecaller` instance (see RecallerOptions.project) and each
// instance owns a private `Map`, so no sequence of `lookup()` calls on
// ONE recaller can ever distinguish a correct `projectPrefix` from one
// hard-coded to return `""` — every key that function produces for that
// instance is used self-consistently regardless, and there is no second
// instance sharing its cache for a wrong key to collide into. That
// specific mutation is only observable at the `cacheKeyFor`/
// `projectPrefix` unit-test layer above. What DOES stay observable
// through `lookup()` on a single instance is the narrower, equally real
// defect this test targets: `cacheKeyFor` silently ignoring `query` (or
// any of the project fields) and mapping every distinct query for a
// project-scoped recaller onto ONE shared entry.
test("distinct queries within one project-scoped recaller do not collide with each other", async () => {
  const answers: Record<string, { id: string; content: string }[]> = {
    "question A": [{ id: "a", content: "answer A" }],
    "question B": [{ id: "b", content: "answer B" }],
  };
  const recaller = createWarmingRecaller({
    config: CONFIG,
    ambient: false,
    log: () => {},
    project: { repo_root: "/repo/klio", git_remote: "git@github.com:klio-tech/klio.git" },
    fetchImpl: (async (_u: any, init: any) => {
      const { query } = JSON.parse(init.body) as { query: string };
      return new Response(JSON.stringify({ memories: answers[query] ?? [] }), { status: 200 });
    }) as unknown as typeof fetch,
  });

  recaller.lookup("question A");
  recaller.lookup("question B");
  await recaller.idle();

  assert.deepEqual(recaller.lookup("question A").memories, answers["question A"]);
  assert.deepEqual(recaller.lookup("question B").memories, answers["question B"]);
  recaller.stop();
});

test("the same query from two different projects does not share a cache entry", async () => {
  // Two independently-configured recallers (one project resolved per
  // recaller instance, per contract) stand in for "two projects talking
  // to recall": each must warm and read back its OWN answer for the
  // identical query text, never the other's.
  const recallerA = createWarmingRecaller({
    config: CONFIG,
    ambient: false,
    log: () => {},
    project: { repo_root: "/repo/a" },
    fetchImpl: (async () =>
      new Response(JSON.stringify({ memories: [{ id: "a1", content: "project A's answer" }] }), {
        status: 200,
      })) as unknown as typeof fetch,
  });
  const recallerB = createWarmingRecaller({
    config: CONFIG,
    ambient: false,
    log: () => {},
    project: { repo_root: "/repo/b" },
    fetchImpl: (async () =>
      new Response(JSON.stringify({ memories: [{ id: "b1", content: "project B's answer" }] }), {
        status: 200,
      })) as unknown as typeof fetch,
  });

  recallerA.lookup("same query text");
  recallerB.lookup("same query text");
  await Promise.all([recallerA.idle(), recallerB.idle()]);

  assert.deepEqual(recallerA.lookup("same query text").memories, [{ id: "a1", content: "project A's answer" }]);
  assert.deepEqual(recallerB.lookup("same query text").memories, [{ id: "b1", content: "project B's answer" }]);

  recallerA.stop();
  recallerB.stop();
});

test("the ambient warming path is scoped by project too", async () => {
  const bodies: Record<string, unknown>[] = [];
  const recaller = createWarmingRecaller({
    config: CONFIG,
    ambient: true,
    log: () => {},
    project: { repo_root: "/repo/klio", git_remote: "git@github.com:klio-tech/klio.git" },
    fetchImpl: (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ memories: [{ id: "a", content: "ambient" }] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  recaller.start();
  await recaller.idle();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.query, AMBIENT_QUERY);
  assert.equal(bodies[0]!.repo_root, "/repo/klio");
  assert.equal(bodies[0]!.git_remote, "git@github.com:klio-tech/klio.git");
  recaller.stop();
});

// ---------------------------------------------------------------------
// The engine now applies a relevance floor and can legitimately answer
// with zero memories. That must read as a SUCCESSFUL, freshness-bounded
// answer (the normal ttlMs) — not a failure (the shorter FAILURE_TTL_MS)
// — so a genuinely-empty answer does not get retried as aggressively as
// a broken engine, but still expires and gets a fair re-ask once stale.
// ---------------------------------------------------------------------

test("a genuinely empty (non-junk) response caches as a success, not a failure", async () => {
  const calls: string[] = [];
  let clock = 1_000;
  const recaller = createWarmingRecaller({
    config: CONFIG,
    ambient: false,
    log: () => {},
    ttlMs: 60_000, // success freshness window
    now: () => clock,
    fetchImpl: okFetch([], calls) as unknown as typeof fetch,
  });

  recaller.lookup("q");
  await recaller.idle();
  assert.equal(recaller.lookup("q").reason, "empty");

  // Past FAILURE_TTL_MS (10s) but still inside ttlMs (60s): a FAILURE
  // entry would already be stale and refetched here; a success-but-empty
  // entry must not be.
  clock += 15_000;
  recaller.lookup("q");
  await recaller.idle();
  assert.equal(calls.length, 1, "an empty-but-successful answer must use the success TTL, not the failure TTL");
  recaller.stop();
});

test("the request path is a cache read: a miss returns immediately", async () => {
  const recaller = createWarmingRecaller({
    config: CONFIG,
    ambient: false,
    log: () => {},
    fetchImpl: (() => new Promise<Response>(() => {})) as unknown as typeof fetch, // never resolves
  });
  const started = Date.now();
  const out = recaller.lookup("anything");
  const elapsed = Date.now() - started;
  assert.deepEqual(out.memories, []);
  assert.equal(out.reason, "cold");
  assert.ok(elapsed < 50, `lookup must not wait (took ${elapsed}ms)`);
  recaller.stop();
});

test("a non-2xx response yields nothing and reads as an error, never throws", async () => {
  const recaller = await warmed(
    { config: CONFIG, fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch },
    "q",
  );
  assert.deepEqual(recaller.lookup("q"), { memories: [], reason: "error" });
  recaller.stop();
});

test("a network error yields nothing and reads as an error, never throws", async () => {
  const recaller = await warmed(
    { config: CONFIG, fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch },
    "q",
  );
  assert.deepEqual(recaller.lookup("q"), { memories: [], reason: "error" });
  recaller.stop();
});

test("malformed JSON yields nothing, never throws", async () => {
  const recaller = await warmed(
    { config: CONFIG, fetchImpl: (async () => new Response("{not json", { status: 200 })) as unknown as typeof fetch },
    "q",
  );
  assert.equal(recaller.lookup("q").reason, "error");
  recaller.stop();
});

test("a null entry in memories[] is filtered, not treated as a failed recall", async () => {
  // `null` reaching `r["content"]` throws a TypeError inside the filter,
  // which the catch below turns into a cached FAILURE — so one junk
  // entry made a perfectly good recall read as `error` and suppressed
  // every usable memory that came with it.
  const recaller = await warmed(
    {
      config: CONFIG,
      fetchImpl: okFetch([null, { id: "1", content: "kept" }, undefined]) as unknown as typeof fetch,
    },
    "q",
  );
  const out = recaller.lookup("q");
  assert.deepEqual(out.memories, [{ id: "1", content: "kept" }]);
  assert.equal(out.reason, "hit");
  recaller.stop();
});

test("memories[] of only junk reads as empty, never as an error", async () => {
  const recaller = await warmed(
    { config: CONFIG, fetchImpl: okFetch([null, undefined, 7, "str"]) as unknown as typeof fetch },
    "q",
  );
  assert.equal(recaller.lookup("q").reason, "empty");
  recaller.stop();
});

test("memories without usable content are dropped", async () => {
  const recaller = await warmed(
    {
      config: CONFIG,
      fetchImpl: okFetch([
        { id: "1", content: "kept" },
        { id: "2", content: "   " },
        { id: "3" },
        { id: "4", content: 7 },
        "not an object",
      ]) as unknown as typeof fetch,
    },
    "q",
  );
  assert.deepEqual(recaller.lookup("q").memories, [{ id: "1", content: "kept" }]);
  recaller.stop();
});

test("a blank query never reaches the network", async () => {
  const calls: string[] = [];
  const recaller = createWarmingRecaller({
    config: CONFIG,
    ambient: false,
    log: () => {},
    fetchImpl: okFetch([{ id: "m1", content: "c" }], calls) as unknown as typeof fetch,
  });
  assert.deepEqual(recaller.lookup("   "), { memories: [], reason: "no-query" });
  await recaller.idle();
  assert.equal(calls.length, 0);
  recaller.stop();
});

test("no config key means no recall and no network", async () => {
  const calls: string[] = [];
  const recaller = createWarmingRecaller({
    config: { ...CONFIG, apiKey: "" },
    ambient: false,
    log: () => {},
    fetchImpl: okFetch([{ id: "m1", content: "c" }], calls) as unknown as typeof fetch,
  });
  assert.deepEqual(recaller.lookup("q"), { memories: [], reason: "no-config" });
  await recaller.idle();
  assert.equal(calls.length, 0);
  recaller.stop();
});

test("a fresh entry is not re-fetched", async () => {
  const calls: string[] = [];
  const recaller = await warmed(
    {
      config: CONFIG,
      ttlMs: 60_000,
      now: () => 1_000,
      fetchImpl: okFetch([{ id: "m1", content: "c" }], calls) as unknown as typeof fetch,
    },
    "same",
  );
  recaller.lookup("same");
  recaller.lookup("same");
  await recaller.idle();
  assert.equal(calls.length, 1, "a fresh entry must be served without another fetch");
  recaller.stop();
});

test("a stale entry is refreshed behind the caller, not dropped", async () => {
  const calls: string[] = [];
  let clock = 1_000;
  const recaller = createWarmingRecaller({
    config: CONFIG,
    ambient: false,
    log: () => {},
    ttlMs: 100,
    now: () => clock,
    fetchImpl: okFetch([{ id: "m1", content: "c" }], calls) as unknown as typeof fetch,
  });
  recaller.lookup("same");
  await recaller.idle();
  assert.equal(calls.length, 1);

  clock += 500;
  const stale = recaller.lookup("same");
  assert.equal(stale.memories.length, 1, "a stale entry is still served");
  assert.equal(stale.reason, "hit");
  await recaller.idle();
  assert.equal(calls.length, 2, "and refreshed behind the caller");
  recaller.stop();
});

test("the ambient set is fetched at start() with the broad query", async () => {
  const bodies: string[] = [];
  const recaller = createWarmingRecaller({
    config: CONFIG,
    ambient: true,
    log: () => {},
    fetchImpl: (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body).query);
      return new Response(JSON.stringify({ memories: [{ id: "a", content: "ambient" }] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  recaller.start();
  await recaller.idle();
  assert.deepEqual(bodies, [AMBIENT_QUERY]);
  assert.equal(recaller.lookup("never asked before").reason, "ambient");
  recaller.stop();
});

test("ambient: false builds layer 2 only", async () => {
  const bodies: string[] = [];
  const recaller = createWarmingRecaller({
    config: CONFIG,
    ambient: false,
    log: () => {},
    fetchImpl: (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body).query);
      return new Response(JSON.stringify({ memories: [{ id: "a", content: "x" }] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  recaller.start();
  await recaller.idle();
  assert.deepEqual(bodies, []);
  assert.equal(recaller.lookup("q").reason, "cold");
  recaller.stop();
});

test("a signal-ignoring fetch is still bounded by the budget", async () => {
  const recaller = createWarmingRecaller({
    config: CONFIG,
    ambient: false,
    log: () => {},
    budgetMs: 50,
    fetchImpl: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
  });
  recaller.lookup("hanging");
  const started = Date.now();
  await recaller.idle();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `the background fetch must end at the budget (took ${elapsed}ms)`);
  assert.equal(recaller.lookup("hanging").reason, "error");
  recaller.stop();
});

test("the budget timeout ABORTS the fetch, it does not just stop waiting for it", async () => {
  // Regression, and a subtle one. The budget was enforced by TWO timers
  // armed at the same deadline: one resolving the race, one calling
  // `controller.abort()`. Node fires same-deadline timers in
  // REGISTRATION order and drains microtasks between them, so with the
  // race timer registered first, the `await` continuation — including
  // the `finally` that clears the abort timer — ran before the abort
  // timer's callback was ever reached. The fetch was orphaned: never
  // aborted, and its controller already dropped from the set `stop()`
  // uses, so nothing could abort it afterwards either. One socket
  // leaked per timed-out miss, forever.
  let aborted = false;
  let sawSignal = false;
  const recaller = createWarmingRecaller({
    config: CONFIG,
    ambient: false,
    log: () => {},
    budgetMs: 50,
    fetchImpl: ((_u: unknown, init: RequestInit) =>
      new Promise<Response>(() => {
        sawSignal = init.signal instanceof AbortSignal;
        init.signal?.addEventListener("abort", () => { aborted = true; });
      })) as unknown as typeof fetch,
  });
  recaller.lookup("an engine that never answers");
  await recaller.idle();
  // Generous slack: if the abort were merely late rather than absent,
  // this would still catch it.
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(sawSignal, true, "the fetch must be given a signal at all");
  assert.equal(aborted, true, "the budget must abort the in-flight fetch, not orphan it");
  recaller.stop();
});

test("no timer outlives a completed background recall", async () => {
  const recaller = createWarmingRecaller({
    config: CONFIG,
    ambient: false,
    log: () => {},
    budgetMs: 5000,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ memories: [{ id: "m1", content: "c" }] }), { status: 200 })) as unknown as typeof fetch,
  });
  const before = (process.getActiveResourcesInfo?.() ?? []).filter((r) => r === "Timeout").length;
  recaller.lookup("quick");
  await recaller.idle();
  const after = (process.getActiveResourcesInfo?.() ?? []).filter((r) => r === "Timeout").length;
  assert.equal(after, before, "no timeout timer should outlive the recall it bounded");
  recaller.stop();
});

test("a failure is logged once, without the query or the key", async () => {
  const logged: string[] = [];
  const recaller = createWarmingRecaller({
    config: { ...CONFIG, apiKey: "super-secret-key" },
    ambient: false,
    log: (l) => logged.push(l),
    fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
  });
  recaller.lookup("a very distinctive query string");
  await recaller.idle();
  recaller.lookup("another distinctive query string");
  await recaller.idle();

  assert.equal(logged.length, 1, "the throttle must collapse a flood into one line");
  assert.match(logged[0]!, /recall failed \(HTTP 503\)/);
  assert.ok(!logged[0]!.includes("distinctive"), "no query text");
  assert.ok(!logged[0]!.includes("super-secret-key"), "no credentials");
  recaller.stop();
});

test("the cache is capped at 256 entries with oldest-out eviction", async () => {
  const calls: string[] = [];
  const recaller = createWarmingRecaller({
    config: CONFIG,
    ambient: false,
    log: () => {},
    fetchImpl: okFetch([{ id: "m1", content: "c" }], calls) as unknown as typeof fetch,
  });
  for (let i = 0; i < 256; i++) {
    recaller.lookup(`query-${i}`);
    await recaller.idle();
  }
  assert.equal(recaller.size(), 256);
  assert.equal(recaller.lookup("query-0").reason, "hit");

  recaller.lookup("query-256");
  await recaller.idle();
  assert.equal(recaller.size(), 256, "the cap must hold");
  assert.equal(recaller.lookup("query-256").reason, "hit", "the newest entry survives");
  assert.equal(recaller.lookup("query-0").reason, "cold", "the oldest was evicted");
  recaller.stop();
});

test("updating an existing entry does not shrink the cache below the cap", async () => {
  let clock = 0;
  const recaller = createWarmingRecaller({
    config: CONFIG,
    ambient: false,
    log: () => {},
    ttlMs: 10,
    now: () => clock,
    fetchImpl: okFetch([{ id: "m1", content: "c" }]) as unknown as typeof fetch,
  });
  for (let i = 0; i < 256; i++) {
    recaller.lookup(`q-${i}`);
    await recaller.idle();
  }
  assert.equal(recaller.size(), 256);
  clock += 1000; // everything is stale now
  recaller.lookup("q-255");
  await recaller.idle();
  assert.equal(recaller.size(), 256, "refreshing an existing key must not evict anything");
  recaller.stop();
});
