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
