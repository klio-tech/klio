// OpenRouter API probes used during interactive onboarding.
//
// Each probe is a single HTTPS round-trip against OpenRouter's REST
// API. They are deliberately small, dependency-free, and self-contained
// so they can be exercised in tests via a `globalThis.fetch` override
// without any networking layer. The orchestrator in `providerSetup.ts`
// composes the three calls behind a retry loop.
//
// All requests use a shared header builder that includes the
// OpenRouter attribution headers (`HTTP-Referer` and `X-Title`). These
// are how OpenRouter tracks which app issued the request and surface
// us on their public leaderboards / per-app analytics — they're
// harmless to send on every call and OpenRouter actively encourages
// them, so we set them once in `orHeaders` and reuse across every
// probe and the catalog fetch.
//
// Error contract — the messages thrown here surface verbatim to the
// user during `klio init`, so they're worded for end-user readability:
//
//   probeKey:
//     - 401 → "Invalid key"
//     - 402 → "Out of credit on this key"
//     - other non-2xx → "OpenRouter unreachable (HTTP <status>)"
//
//   probeEmbeddingModel / probeChatModel:
//     - non-2xx with `{error: {message}}` → that message verbatim
//     - non-2xx without a usable message → "Model probe failed (HTTP <status>)"
//
//   fetchModelCatalog:
//     - non-2xx → "OpenRouter /models failed (HTTP <status>)"

const BASE = "https://openrouter.ai/api/v1";

export type KeyInfo = {
  /** Human-readable label OpenRouter assigns to the key. */
  label: string;
  /**
   * Remaining credit on this key in USD, or null when the key is
   * unmetered. We treat null as "fine" rather than as an error.
   */
  creditRemaining: number | null;
};

export type EmbeddingProbe = {
  /** Dimensionality of the returned embedding vector. */
  dim: number;
  /** Tokens billed for the probe (used to surface "test cost = N"). */
  tokensUsed: number;
};

export type ChatProbe = {
  /** Tokens billed for the probe (0 when usage is omitted by the model). */
  tokensUsed: number;
  /** Wall-clock ms spent on the request. */
  latencyMs: number;
};

/**
 * Subset of the OpenRouter `/models` response we care about. The full
 * payload has many more fields; we keep this narrow so the curation
 * helpers don't accidentally couple to fields they don't need.
 */
export type CatalogEntry = {
  id: string;
  architecture?: { modality?: string };
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  context_length?: number;
};

/**
 * Embedding models on OpenRouter don't expose their output dim in the
 * catalog. We maintain a hand-curated map here keyed off the model id
 * so the picker can show "1536 dim" without making a probe call up
 * front. Models absent from this map are filtered out of the picker
 * (the user can still type any name as a custom override).
 */
const SUPPORTED_EMBED_DIMS_BY_MODEL: Record<string, number> = {
  "openai/text-embedding-3-small": 1536,
  "openai/text-embedding-ada-002": 1536,
  "voyage/voyage-3": 1024,
  "voyage/voyage-3-lite": 512,
  "cohere/embed-multilingual-v3.0": 1024,
  "cohere/embed-english-v3.0": 1024,
};

/**
 * pgvector dimensions the engine schema is wired up to accept. Models
 * with dims outside this set are filtered out of the curated picker
 * because the engine cannot index them as-is.
 */
const SUPPORTED_DIMS = new Set([768, 1024, 1536]);

/**
 * The chat models we present in the picker, in the order they appear.
 * Curated for tradeoff coverage: cheap-and-fast vs. premium-quality
 * across three providers (Anthropic, OpenAI, Google) plus an
 * open-weights option (Llama).
 */
const CURATED_CHAT_MODELS = [
  "anthropic/claude-3-5-haiku",
  "anthropic/claude-3-5-sonnet",
  "openai/gpt-4o-mini",
  "openai/gpt-4o",
  "google/gemini-flash-1.5",
  "meta-llama/llama-3.1-70b-instruct",
];

/**
 * Build the standard set of headers every OpenRouter call uses. The
 * `HTTP-Referer` and `X-Title` fields are how OpenRouter attributes
 * traffic to specific apps on their analytics/leaderboards; we set
 * them on every probe and on the catalog fetch.
 */
function orHeaders(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://klio.tech",
    "X-Title": "Klio",
  };
}

/**
 * Validate an OpenRouter API key and return basic metadata about it.
 * Distinguishes "invalid key" (401), "out of credit" (402), and "any
 * other failure" so the caller can surface a precise message.
 */
export async function probeKey(key: string): Promise<KeyInfo> {
  const res = await fetch(`${BASE}/auth/key`, {
    headers: orHeaders(key),
  });
  if (res.status === 401) throw new Error("Invalid key");
  if (res.status === 402) throw new Error("Out of credit on this key");
  if (!res.ok) {
    throw new Error(`OpenRouter unreachable (HTTP ${res.status})`);
  }
  const body = (await res.json()) as {
    data: { label: string; limit_remaining: number | null };
  };
  return {
    label: body.data.label,
    creditRemaining: body.data.limit_remaining,
  };
}

/**
 * Issue a one-token embedding request to confirm the model is
 * reachable and discover its output dimensionality. The dim feeds
 * straight into pgvector's column type, so we cannot proceed without
 * it.
 */
export async function probeEmbeddingModel(
  key: string,
  model: string,
): Promise<EmbeddingProbe> {
  const res = await fetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: orHeaders(key),
    body: JSON.stringify({ model, input: "ok" }),
  });
  const body = (await safeJson(res)) as
    | {
        data: { embedding: number[] }[];
        usage?: { total_tokens?: number };
      }
    | { error?: { message?: string } };
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } }).error?.message;
    throw new Error(msg ?? `Model probe failed (HTTP ${res.status})`);
  }
  const data = (body as { data: { embedding: number[] }[] }).data;
  if (!data?.[0]?.embedding) {
    throw new Error("Unexpected response shape from /embeddings");
  }
  return {
    dim: data[0].embedding.length,
    tokensUsed:
      (body as { usage?: { total_tokens?: number } }).usage?.total_tokens ?? 0,
  };
}

/**
 * Issue a minimal one-token chat completion to verify the model
 * responds. We pin `max_tokens: 1` so the probe stays cheap. Some
 * providers omit the `usage` block on tiny replies, so we tolerate a
 * missing total and report 0 tokens in that case.
 */
export async function probeChatModel(
  key: string,
  model: string,
): Promise<ChatProbe> {
  const start = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: orHeaders(key),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "ok" }],
      max_tokens: 1,
    }),
  });
  const body = (await safeJson(res)) as
    | {
        choices: { message: { content: string } }[];
        usage?: { total_tokens?: number };
      }
    | { error?: { message?: string } };
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } }).error?.message;
    throw new Error(msg ?? `Model probe failed (HTTP ${res.status})`);
  }
  return {
    tokensUsed:
      (body as { usage?: { total_tokens?: number } }).usage?.total_tokens ?? 0,
    latencyMs: Date.now() - start,
  };
}

/**
 * Fetch OpenRouter's full model catalog. The response is large
 * (hundreds of entries) but the curation helpers below distill it to
 * the handful we surface in the picker. We expose the raw catalog so
 * other call sites (e.g. future `klio doctor`) can reuse it.
 */
export async function fetchModelCatalog(
  key: string,
): Promise<CatalogEntry[]> {
  const res = await fetch(`${BASE}/models`, {
    headers: orHeaders(key),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter /models failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { data?: CatalogEntry[] };
  return body.data ?? [];
}

/**
 * Filter a catalog down to embedding models we can actually use, then
 * sort by prompt-token price ascending and keep the top three. The
 * dim filter is critical — pgvector columns are dim-typed, so a model
 * whose dim is outside `SUPPORTED_DIMS` would fail at insert time.
 */
export function curateEmbeddingModels(
  catalog: CatalogEntry[],
): CatalogEntry[] {
  return catalog
    .filter((m) => m.architecture?.modality === "text->embedding")
    .filter((m) => {
      const dim = SUPPORTED_EMBED_DIMS_BY_MODEL[m.id];
      return dim !== undefined && SUPPORTED_DIMS.has(dim);
    })
    .slice()
    .sort(
      (a, b) =>
        Number(a.pricing?.prompt ?? "0") - Number(b.pricing?.prompt ?? "0"),
    )
    .slice(0, 3);
}

/**
 * Reduce a catalog to the curated chat models we surface in the
 * picker. Order is preserved from `CURATED_CHAT_MODELS` (not the
 * catalog) so the user-facing list is stable across catalog changes.
 * Models that are missing from the catalog, are not chat-modality, or
 * don't support tool-calling are dropped — tool support is a hard
 * requirement because the extraction model needs structured output.
 */
export function curateChatModels(catalog: CatalogEntry[]): CatalogEntry[] {
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const out: CatalogEntry[] = [];
  for (const id of CURATED_CHAT_MODELS) {
    const entry = byId.get(id);
    if (!entry) continue;
    if (entry.architecture?.modality !== "text->text") continue;
    if (!entry.supported_parameters?.includes("tools")) continue;
    out.push(entry);
  }
  return out;
}

/**
 * Look up the known dim for an embedding model id. Used by the picker
 * to show "1536 dim" inline next to the model name. Returns
 * `undefined` for unknown models so callers can decide how to render
 * the unknown case.
 */
export function knownEmbedDim(modelId: string): number | undefined {
  return SUPPORTED_EMBED_DIMS_BY_MODEL[modelId];
}

/**
 * Like `res.json()` but returns an empty object instead of throwing
 * when the body is empty or not valid JSON. We need this on error
 * paths where the provider may return a plain-text 5xx — the caller
 * still wants to inspect the optional `error.message` shape and fall
 * back to the generic message when that's absent.
 */
async function safeJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}
