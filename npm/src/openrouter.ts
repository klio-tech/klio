// OpenRouter API probes used during interactive onboarding.
//
// Each probe is a single HTTPS round-trip against OpenRouter's REST
// API. They are deliberately small, dependency-free, and self-contained
// so they can be exercised in tests via a `globalThis.fetch` override
// without any networking layer. The orchestrator in `providerSetup.ts`
// composes the three calls behind a retry loop.
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
 * Validate an OpenRouter API key and return basic metadata about it.
 * Distinguishes "invalid key" (401), "out of credit" (402), and "any
 * other failure" so the caller can surface a precise message.
 */
export async function probeKey(key: string): Promise<KeyInfo> {
  const res = await fetch(`${BASE}/auth/key`, {
    headers: { Authorization: `Bearer ${key}` },
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
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
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
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
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
