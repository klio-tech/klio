// Custom OpenAI-compatible endpoint probes used during interactive
// onboarding.
//
// A "custom endpoint" is any user-supplied OpenAI-compatible server —
// LiteLLM proxy, Azure OpenAI, vLLM, Together, Groq, an internal
// gateway, etc. These all speak the same wire shape as OpenRouter
// (`/models`, `/embeddings`, `/chat/completions`), so the probes here
// mirror their OpenRouter counterparts but are parameterised on
// `baseUrl` and `apiKey`.
//
// Two structural differences from `openrouter.ts`:
//
//   1. The API key is optional. Many local proxies (LiteLLM, vLLM in
//      dev mode, internal gateways with mTLS) reject the literal
//      `Authorization: Bearer ` header when the bearer is empty. We
//      omit the Authorization header entirely when the key is empty
//      or undefined.
//
//   2. The `/models` endpoint may be disabled by the proxy (returns
//      404). That isn't an error — the user can still type model
//      names manually. `probeCustomEndpoint` returns
//      `{modelsAvailable: 0, modelsList: null}` in that case so the
//      orchestrator can fall back to free-form input.
//
// We still send the Klio attribution headers (`X-Title`, `HTTP-Referer`)
// on every request. They're harmless to proxies that ignore them and
// useful to ones that log them.
//
// Error contract — these messages surface verbatim to the user during
// `klio init`:
//
//   probeCustomEndpoint:
//     - 401 → "Invalid key"
//     - 403 → "Forbidden — key lacks access"
//     - 404 → modelsList=null (no throw; proxy disabled /models)
//     - other non-2xx → "Custom endpoint unreachable (HTTP <status>)"
//
//   probeCustomEmbedding / probeCustomChat:
//     - non-2xx with `{error: {message}}` → that message verbatim
//     - non-2xx without a usable message → "Model probe failed (HTTP <status>)"

export type CustomKeyInfo = {
  /** Count of models reported by `/models`, or 0 if the endpoint disabled it. */
  modelsAvailable: number;
  /**
   * List of model ids if `/models` returned them; null when the proxy
   * returned 404 (endpoint disabled). The orchestrator uses null to
   * decide whether to render a numbered picker or a free-form prompt.
   */
  modelsList: string[] | null;
};

export type CustomEmbeddingProbe = {
  /** Dimensionality of the returned embedding vector. */
  dim: number;
  /** Tokens billed for the probe (used to surface "test cost = N"). */
  tokensUsed: number;
};

export type CustomChatProbe = {
  /** Tokens billed for the probe (0 when usage is omitted by the proxy). */
  tokensUsed: number;
  /** Wall-clock ms spent on the request. */
  latencyMs: number;
};

/**
 * Build the standard set of headers for every custom-endpoint call.
 * Authorization is omitted entirely when `apiKey` is empty or
 * undefined — some local proxies reject `Bearer ` (empty bearer)
 * with a 400. The attribution headers are always sent; proxies that
 * don't recognise them ignore them harmlessly.
 */
function customHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "HTTP-Referer": "https://klio.tech",
    "X-Title": "Klio",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Strip any number of trailing slashes from the base URL so we can
 * safely concatenate `/models`, `/embeddings`, etc. without producing
 * `https://x/v1//models`. We only trim trailing slashes — leading and
 * embedded slashes are preserved.
 */
function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Validate `baseUrl` + `apiKey` by listing models. Three success
 * shapes:
 *
 *   - 200 with a populated `data` array → `modelsAvailable=N,
 *     modelsList=[…]`. The orchestrator renders a numbered picker.
 *   - 200 with an empty/missing `data` array → `modelsAvailable=0,
 *     modelsList=[]`. The orchestrator should still show free-form
 *     input.
 *   - 404 → `modelsAvailable=0, modelsList=null`. The proxy disabled
 *     the endpoint; the user can still type names manually.
 *
 * Auth failures (401/403) and reachability failures (5xx + unmatched
 * 4xx) throw with a precise message so the caller can re-prompt with
 * a useful hint.
 */
export async function probeCustomEndpoint(
  baseUrl: string,
  apiKey: string | undefined,
): Promise<CustomKeyInfo> {
  const url = `${trimTrailingSlash(baseUrl)}/models`;
  const res = await fetch(url, { headers: customHeaders(apiKey) });
  if (res.status === 401) throw new Error("Invalid key");
  if (res.status === 403) throw new Error("Forbidden — key lacks access");
  if (res.status === 404) {
    // Proxy disabled /models — that's fine, the user can type names
    // manually. We surface this as a distinct sentinel so the
    // orchestrator can pivot to free-form input.
    return { modelsAvailable: 0, modelsList: null };
  }
  if (!res.ok) {
    throw new Error(`Custom endpoint unreachable (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { data?: { id: string }[] };
  const list = (body.data ?? []).map((m) => m.id);
  return { modelsAvailable: list.length, modelsList: list };
}

/**
 * Issue a one-token embedding request to confirm the model is
 * reachable and discover its output dim. Mirrors
 * `probeEmbeddingModel` from `openrouter.ts` but is parameterised on
 * `baseUrl` + `apiKey`.
 */
export async function probeCustomEmbedding(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
): Promise<CustomEmbeddingProbe> {
  const url = `${trimTrailingSlash(baseUrl)}/embeddings`;
  const res = await fetch(url, {
    method: "POST",
    headers: customHeaders(apiKey),
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
 * responds. Pinned to `max_tokens: 1` so the probe stays cheap. Some
 * proxies omit `usage` on tiny replies; we tolerate that and report 0.
 */
export async function probeCustomChat(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
): Promise<CustomChatProbe> {
  const url = `${trimTrailingSlash(baseUrl)}/chat/completions`;
  const start = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: customHeaders(apiKey),
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
 * paths where the proxy may return a plain-text 5xx — the caller
 * still wants to inspect the optional `error.message` shape and fall
 * back to the generic message when it's absent.
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
