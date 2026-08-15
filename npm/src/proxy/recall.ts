// Recall client for the proxy's injection path — a WARM CACHE the
// request path reads, and a background warmer that fills it.
//
// WHY THIS IS NOT A REQUEST-PATH FETCH ANY MORE.
//
// The original design gave recall a 300 ms in-request budget: recall
// inline, inject if it answered in time, forward uninjected if not.
// Measured against the production engine on 2026-08-15, `POST
// /capture/recall` took 5.90 s, 6.18 s and 6.47 s on three consecutive
// calls. So every request timed out, every request injected nothing,
// and — because the timeout path deliberately cached nothing — nothing
// ever warmed up. `x-klio-injected` was `0` on every request in
// production, and fail-open made that indistinguishable from "no
// relevant memories". The mechanism was sound: with the budget raised
// to 15 s and nothing else changed, the same request injected 13
// memories and the model answered with content that exists only in the
// org's memory. It cost 10.96 s, ~6 s of it recall sitting on the
// request path.
//
// Both halves of that are unacceptable, and they are in tension only if
// the fetch has to happen while the user waits. So it does not:
//
//   * The REQUEST PATH performs a CACHE READ ONLY. {@link
//     WarmingRecaller.lookup} is synchronous, touches no socket, and
//     cannot block. There is no request-path budget any more because
//     there is no request-path network call to bound.
//   * BACKGROUND FETCHES fill that cache, on a budget generous enough
//     for an endpoint that genuinely takes ~6 s (see
//     {@link DEFAULT_BUDGET_MS}) but still bounded, since an unbounded
//     fetch is a leak with extra steps.
//
// Two layers make the cache non-empty when it matters:
//
//   1. AMBIENT. Recall is keyed by the conversation's last user
//      message, so the exact query of a turn that has not happened yet
//      cannot be pre-fetched. What CAN be pre-fetched is a broad,
//      org-scoped "what is this team working on" set, refreshed on an
//      interval. It covers the first turn of a session, which would
//      otherwise always be cold. Verified against the production engine
//      before being built: a broad query is answered meaningfully
//      (12–13 org memories in ~6 s), so this layer is worth having
//      rather than a query the engine would answer badly.
//   2. PER-QUERY. A miss injects whatever ambient offers (or nothing)
//      and returns immediately, while a fire-and-forget recall for that
//      exact query fills the cache behind it. Agent loops repeat and
//      refine similar queries within a session, so turn 2 onward hits
//      warm.
//
// Invariants this module holds, all of them load-bearing:
//
//   * NEVER THROWS into the request path. Every failure is a cache
//     entry that says "no memories, and here is why".
//   * SINGLE FLIGHT per query. A cache miss under an agent loop would
//     otherwise stampede the engine with one recall per turn — 20
//     concurrent misses produced 20 upstream recalls before this.
//   * BOUNDED. One cache, 256 entries, oldest out; one in-flight fetch
//     per key; every fetch on a wall-clock budget.
//   * STALE-WHILE-REVALIDATE. An expired entry is SERVED and refreshed
//     behind the request, never dropped — dropping it would put the
//     next turn back to cold for ~6 s every TTL.
//   * NO TIMER OUTLIVES ITS WORK, and {@link WarmingRecaller.stop}
//     clears everything, so the process can exit.

import type { CloudConfig } from "../cloudConfig.js";
import type { Memory } from "./inject.js";

/**
 * How long a cached answer is considered FRESH. Past this an entry is
 * still served (see stale-while-revalidate above) but a refresh is
 * scheduled behind it.
 */
const DEFAULT_TTL_MS = 60_000;

/**
 * A FAILED answer is cached too, and deliberately for less time. Caching
 * it at all is what keeps a broken engine from being re-hit on every
 * single turn; caching it briefly is what lets a transient failure heal
 * without waiting out the full TTL.
 */
const FAILURE_TTL_MS = 10_000;

/**
 * Wall-clock budget for ONE background fetch. Generous on purpose —
 * production recall measured 5.9–6.5 s, and a budget under that is how
 * the original defect happened. Bounded on purpose too: this runs on an
 * interval and on every cache miss, so an unbounded fetch would let slow
 * responses pile up.
 */
const DEFAULT_BUDGET_MS = 20_000;

/** How often the ambient set is refreshed. */
const DEFAULT_AMBIENT_INTERVAL_MS = 5 * 60_000;

const RECALL_LIMIT = 8;
const MAX_CACHE_ENTRIES = 256;

/**
 * Cache key for the ambient set. Starts with a NUL so it can never
 * collide with a real query: a query is the text of a user message, and
 * `lookup` rejects one that is blank, but nothing stops a user message
 * containing any printable string.
 */
const AMBIENT_KEY = "\u0000klio-ambient";

/**
 * The broad query behind the ambient set. Phrased as a question about
 * durable team context rather than a keyword soup, because the engine
 * embeds it: verified live before being adopted (12 org memories in
 * ~6 s, versus 8 for an empty query).
 */
export const AMBIENT_QUERY =
  "team project context: key decisions, conventions, architecture, and current work";

/** At most one failure log per this window, so a broken engine cannot flood. */
const LOG_THROTTLE_MS = 60_000;

/**
 * Response header naming WHY `x-klio-injected` is what it is.
 *
 * `x-klio-injected: 0` alone meant five different things — injection
 * switched off, no cloud config, a cold cache, a warm cache with no
 * relevant memories, or a recall that failed — and that ambiguity is
 * exactly what hid the production defect for the length of a branch.
 * The count says WHAT happened; this says WHY.
 */
export const INJECT_REASON_HEADER = "x-klio-injected-reason";

/**
 * Why injection did (or did not) happen. Every value is reported on the
 * response as {@link INJECT_REASON_HEADER}.
 *
 *   * `hit`             — served from this query's own warm entry.
 *   * `ambient`         — served from the broad startup/interval set.
 *   * `cold`            — nothing cached yet; a fetch was started.
 *   * `empty`           — recall answered, with no memories.
 *   * `error`           — the last recall for this query failed or timed out.
 *   * `no-query`        — the request carries no user text to recall on.
 *   * `disabled`        — `KLIO_PROXY_INJECT=off` (or the persisted toggle).
 *   * `no-config`       — no cloud config, so there is nothing to recall from.
 *   * `not-applicable`  — not a request injection could ever apply to.
 *   * `not-injectable`  — memories were available, but the body could not be
 *                         mutated safely (see inject.ts's byte-stability guard).
 */
export type InjectReason =
  | "hit"
  | "ambient"
  | "cold"
  | "empty"
  | "error"
  | "no-query"
  | "disabled"
  | "no-config"
  | "not-applicable"
  | "not-injectable";

/** What the request path gets back. Always immediate, never a promise. */
export type RecallLookup = { memories: Memory[]; reason: InjectReason };

/** The seam `createProxyServer` consumes. Synchronous by contract. */
export type LookupFn = (query: string) => RecallLookup;

export type RecallerOptions = {
  config: CloudConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Freshness window for a cached answer. Default 60 s. */
  ttlMs?: number;
  /** Wall-clock budget for one background fetch. Default 20 s. */
  budgetMs?: number;
  /** Ambient refresh cadence. Default 5 min. */
  ambientIntervalMs?: number;
  /** Default true. `false` builds layer 2 only. */
  ambient?: boolean;
  /** Where failure lines go. Defaults to stderr. */
  log?: (line: string) => void;
};

export type WarmingRecaller = {
  /**
   * CACHE READ ONLY — no network, no waiting, never throws. May schedule
   * a background fetch as a side effect; it does not wait for it.
   */
  lookup: LookupFn;
  /** Begin ambient warming. Idempotent. */
  start: () => void;
  /** Stop all warming, clear every timer, abort what is in flight. Idempotent. */
  stop: () => void;
  /** Resolves when no background fetch is in flight. For tests and shutdown. */
  idle: () => Promise<void>;
  /** Entries currently cached, ambient included. For tests. */
  size: () => number;
};

type CacheEntry = {
  at: number;
  memories: Memory[];
  /** True when this entry records a failure rather than an answer. */
  failed: boolean;
};

export function createWarmingRecaller(opts: RecallerOptions): WarmingRecaller {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const ambientIntervalMs = opts.ambientIntervalMs ?? DEFAULT_AMBIENT_INTERVAL_MS;
  const ambientEnabled = opts.ambient !== false;
  const log = opts.log ?? ((line: string) => process.stderr.write(line + "\n"));

  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<void>>();
  const controllers = new Set<AbortController>();

  let ambientTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let lastLoggedAt = 0;
  let suppressedLogs = 0;

  function isStale(entry: CacheEntry): boolean {
    const age = now() - entry.at;
    return age >= (entry.failed ? FAILURE_TTL_MS : ttlMs);
  }

  function store(key: string, entry: CacheEntry): void {
    // Cap with oldest-out eviction, but only when ADDING a key — an
    // update must not shrink the cache below the cap. The ambient entry
    // is never the victim: it is inserted first, so plain insertion-order
    // eviction would take it out the moment 256 queries went by, and the
    // first turn of every later session would be cold again.
    if (!cache.has(key) && cache.size >= MAX_CACHE_ENTRIES) {
      for (const candidate of cache.keys()) {
        if (candidate === AMBIENT_KEY) continue;
        cache.delete(candidate);
        break;
      }
    }
    cache.set(key, entry);
  }

  function reportFailure(detail: string): void {
    const at = now();
    if (at - lastLoggedAt < LOG_THROTTLE_MS) {
      suppressedLogs++;
      return;
    }
    const suffix = suppressedLogs > 0 ? ` (${suppressedLogs} similar suppressed)` : "";
    lastLoggedAt = at;
    suppressedLogs = 0;
    // Deliberately carries NO query text, NO memory content and NO
    // credentials — only the shape of the failure. This line exists so
    // "injection is doing nothing" is never silent again, not to make
    // the conversation greppable in a log file.
    log(`klio proxy: background recall failed (${detail}) — injecting nothing until it recovers${suffix}`);
  }

  /**
   * One background fetch. NEVER throws and never rejects: every outcome
   * is a cache entry. Bounded by both an abort signal and a wall-clock
   * race, because a `fetch` implementation that ignores its signal must
   * still not hold the budget open (measured: it does not, but the race
   * is what makes that true rather than hoped for).
   */
  async function fetchInto(key: string, query: string): Promise<void> {
    const controller = new AbortController();
    controllers.add(controller);
    let abortTimer: NodeJS.Timeout | undefined;
    let budgetTimer: NodeJS.Timeout | undefined;

    // Deliberately NOT `unref`'d, unlike the ambient interval. These two
    // are the only thing bounding a fetch that has already started: an
    // `unref`'d budget timer does not fire in a process with nothing
    // else pending, so a hung recall would never be abandoned and
    // `idle()` would never settle. They are short-lived (budgetMs),
    // cleared in the `finally` below, and `stop()` aborts the fetch that
    // owns them — so the window in which they can hold the process open
    // is bounded and always closable.
    const deadline = new Promise<null>((resolve) => {
      budgetTimer = setTimeout(() => resolve(null), budgetMs);
    });
    abortTimer = setTimeout(() => controller.abort(), budgetMs);

    try {
      const res = await Promise.race([
        doFetch(`${opts.config.baseUrl}/capture/recall`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Vex-Key": opts.config.apiKey,
            "X-Vex-Agent": opts.config.agentId,
          },
          body: JSON.stringify({ query, limit: RECALL_LIMIT, scope: "org" }),
          signal: controller.signal,
        }),
        deadline,
      ]);

      if (!res) {
        // The budget won the race.
        store(key, { at: now(), memories: [], failed: true });
        reportFailure(`timed out after ${budgetMs}ms`);
        return;
      }

      const response = res as Response;
      if (!response.ok) {
        store(key, { at: now(), memories: [], failed: true });
        reportFailure(`HTTP ${response.status}`);
        return;
      }

      const payload = (await response.json()) as { memories?: unknown };
      const raw = Array.isArray(payload.memories) ? payload.memories : [];
      const memories: Memory[] = raw
        .map((r) => r as Record<string, unknown>)
        .filter((r) => typeof r["content"] === "string" && (r["content"] as string).trim() !== "")
        .map((r) => ({ id: String(r["id"] ?? ""), content: String(r["content"]) }));

      store(key, { at: now(), memories, failed: false });
    } catch (err) {
      // Abort, network failure, malformed JSON — all the same answer,
      // and all cached as a failure so the next turn can SAY so.
      store(key, { at: now(), memories: [], failed: true });
      if (!stopped) reportFailure(err instanceof Error ? err.name : "unknown error");
    } finally {
      controllers.delete(controller);
      if (abortTimer !== undefined) clearTimeout(abortTimer);
      if (budgetTimer !== undefined) clearTimeout(budgetTimer);
    }
  }

  /** Start a fetch for `key` unless one is already running for it. */
  function schedule(key: string, query: string): void {
    if (stopped) return;
    if (inFlight.has(key)) return;
    const run = fetchInto(key, query).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, run);
    // `fetchInto` cannot reject, but an unhandled rejection here would
    // be a process-level crash rather than a missing injection, so the
    // guard stays.
    run.catch(() => {});
  }

  function scheduleAmbient(): void {
    if (!ambientEnabled) return;
    schedule(AMBIENT_KEY, AMBIENT_QUERY);
  }

  function lookup(query: string): RecallLookup {
    if (!opts.config.apiKey) return { memories: [], reason: "no-config" };
    if (!query.trim()) return { memories: [], reason: "no-query" };

    const entry = cache.get(query);
    if (!entry || isStale(entry)) schedule(query, query);
    if (entry && entry.memories.length > 0) return { memories: entry.memories, reason: "hit" };

    const ambient = ambientEnabled ? cache.get(AMBIENT_KEY) : undefined;
    if (ambientEnabled && (!ambient || isStale(ambient))) scheduleAmbient();
    if (ambient && ambient.memories.length > 0) {
      return { memories: ambient.memories, reason: "ambient" };
    }

    if (entry) return { memories: [], reason: entry.failed ? "error" : "empty" };
    return { memories: [], reason: "cold" };
  }

  return {
    lookup,
    start(): void {
      if (stopped || !ambientEnabled || ambientTimer !== undefined) return;
      scheduleAmbient();
      ambientTimer = setInterval(scheduleAmbient, ambientIntervalMs);
      // A refresh cadence must never be the reason a process will not
      // exit. `stop()` clears it; `unref` covers every path that forgets
      // to call `stop()` at all.
      ambientTimer.unref?.();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (ambientTimer !== undefined) {
        clearInterval(ambientTimer);
        ambientTimer = undefined;
      }
      for (const controller of controllers) controller.abort();
    },
    async idle(): Promise<void> {
      // A settling fetch can schedule nothing new (schedule() is gated
      // on `stopped` and only ever called from lookup/interval), but it
      // can still be mid-`finally`, so drain until the map is empty.
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight.values()]);
      }
    },
    size(): number {
      return cache.size;
    },
  };
}
