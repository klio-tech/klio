// Tests for the OpenRouter probe functions.
//
// We override `globalThis.fetch` for the duration of each test. The
// override is a no-network mock that lets us assert the request shape
// (URL, method, headers, body) and synthesise an arbitrary `Response`
// for the function under test to consume. After each test we restore
// the original fetch so unrelated tests stay hermetic.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  probeKey,
  probeEmbeddingModel,
  probeChatModel,
  fetchModelCatalog,
  curateEmbeddingModels,
  curateChatModels,
} from "../src/openrouter.js";

type FetchHandler = (req: Request) => Response | Promise<Response>;

const originalFetch = globalThis.fetch;

function mockFetch(handler: FetchHandler): void {
  // The cast goes through `unknown` because TypeScript's lib types for
  // `fetch` use a union of overloads that the simpler handler shape
  // here is compatible with at runtime but not structurally
  // assignable to. The handler is only ever invoked with the standard
  // (RequestInfo|URL, RequestInit?) tuple Node's global fetch uses.
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const req = new Request(
      ...(args as ConstructorParameters<typeof Request>),
    );
    return handler(req);
  }) as unknown as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

test("probeKey returns metadata on 200", async (t) => {
  t.after(restoreFetch);
  mockFetch(async (req) => {
    assert.equal(req.url, "https://openrouter.ai/api/v1/auth/key");
    assert.equal(req.headers.get("authorization"), "Bearer sk-or-test");
    return new Response(
      JSON.stringify({ data: { label: "test", limit_remaining: 42.13 } }),
      { status: 200 },
    );
  });
  const r = await probeKey("sk-or-test");
  assert.equal(r.label, "test");
  assert.equal(r.creditRemaining, 42.13);
});

test("probeKey throws Invalid key on 401", async (t) => {
  t.after(restoreFetch);
  mockFetch(async () => new Response("unauthorized", { status: 401 }));
  await assert.rejects(() => probeKey("bad"), /Invalid key/);
});

test("probeKey throws Out of credit on 402", async (t) => {
  t.after(restoreFetch);
  mockFetch(async () => new Response("payment required", { status: 402 }));
  await assert.rejects(() => probeKey("broke"), /Out of credit/);
});

test("probeKey throws unreachable on 5xx", async (t) => {
  t.after(restoreFetch);
  mockFetch(async () => new Response("boom", { status: 503 }));
  await assert.rejects(
    () => probeKey("k"),
    /OpenRouter unreachable \(HTTP 503\)/,
  );
});

test("probeKey accepts null limit_remaining (unlimited key)", async (t) => {
  t.after(restoreFetch);
  mockFetch(
    async () =>
      new Response(
        JSON.stringify({ data: { label: "unlimited", limit_remaining: null } }),
        { status: 200 },
      ),
  );
  const r = await probeKey("k");
  assert.equal(r.label, "unlimited");
  assert.equal(r.creditRemaining, null);
});

test("probeEmbeddingModel returns dim on success", async (t) => {
  t.after(restoreFetch);
  mockFetch(async (req) => {
    assert.equal(req.url, "https://openrouter.ai/api/v1/embeddings");
    assert.equal(req.method, "POST");
    assert.equal(req.headers.get("authorization"), "Bearer sk-or-test");
    const body = (await req.json()) as { model: string; input: string };
    assert.equal(body.model, "openai/text-embedding-3-small");
    assert.equal(body.input, "ok");
    return new Response(
      JSON.stringify({
        data: [{ embedding: new Array(1536).fill(0) }],
        usage: { total_tokens: 1 },
      }),
      { status: 200 },
    );
  });
  const r = await probeEmbeddingModel(
    "sk-or-test",
    "openai/text-embedding-3-small",
  );
  assert.equal(r.dim, 1536);
  assert.equal(r.tokensUsed, 1);
});

test("probeEmbeddingModel throws with provider message on 404", async (t) => {
  t.after(restoreFetch);
  mockFetch(
    async () =>
      new Response(JSON.stringify({ error: { message: "Model not found" } }), {
        status: 404,
      }),
  );
  await assert.rejects(
    () => probeEmbeddingModel("k", "made-up/model"),
    /Model not found/,
  );
});

test("probeEmbeddingModel falls back to generic error when no body message", async (t) => {
  t.after(restoreFetch);
  mockFetch(async () => new Response("", { status: 500 }));
  await assert.rejects(
    () => probeEmbeddingModel("k", "x"),
    /Model probe failed \(HTTP 500\)/,
  );
});

test("probeChatModel returns a response", async (t) => {
  t.after(restoreFetch);
  mockFetch(async (req) => {
    assert.equal(req.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(req.method, "POST");
    const body = (await req.json()) as {
      model: string;
      messages: { role: string; content: string }[];
      max_tokens: number;
    };
    assert.equal(body.model, "anthropic/claude-3-5-haiku");
    assert.deepEqual(body.messages, [{ role: "user", content: "ok" }]);
    assert.equal(body.max_tokens, 1);
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { total_tokens: 4 },
      }),
      { status: 200 },
    );
  });
  const r = await probeChatModel("k", "anthropic/claude-3-5-haiku");
  assert.equal(r.tokensUsed, 4);
  assert.ok(r.latencyMs >= 0);
});

test("probeChatModel tolerates missing usage block (tokensUsed=0)", async (t) => {
  t.after(restoreFetch);
  mockFetch(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" } }],
        }),
        { status: 200 },
      ),
  );
  const r = await probeChatModel("k", "m");
  assert.equal(r.tokensUsed, 0);
});

test("probeChatModel throws with provider message on non-2xx", async (t) => {
  t.after(restoreFetch);
  mockFetch(
    async () =>
      new Response(
        JSON.stringify({ error: { message: "rate limited" } }),
        { status: 429 },
      ),
  );
  await assert.rejects(
    () => probeChatModel("k", "m"),
    /rate limited/,
  );
});

test("fetchModelCatalog returns the data array with attribution headers sent", async (t) => {
  t.after(restoreFetch);
  const captured: { url?: string; headers?: Record<string, string> } = {};
  mockFetch(async (req) => {
    captured.url = req.url;
    captured.headers = Object.fromEntries(req.headers.entries());
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "openai/text-embedding-3-small",
            architecture: { modality: "text->embedding" },
            pricing: { prompt: "0.00000002" },
          },
        ],
      }),
      { status: 200 },
    );
  });
  const cat = await fetchModelCatalog("sk-or-test");
  assert.equal(captured.url, "https://openrouter.ai/api/v1/models");
  assert.equal(captured.headers?.["x-title"], "Klio");
  assert.equal(captured.headers?.["http-referer"], "https://klio.tech");
  assert.equal(cat.length, 1);
});

test("probeKey now sends attribution headers too", async (t) => {
  t.after(restoreFetch);
  const captured: { headers?: Record<string, string> } = {};
  mockFetch(async (req) => {
    captured.headers = Object.fromEntries(req.headers.entries());
    return new Response(
      JSON.stringify({ data: { label: "x", limit_remaining: 1 } }),
      { status: 200 },
    );
  });
  await probeKey("sk-or-test");
  assert.equal(captured.headers?.["x-title"], "Klio");
  assert.equal(captured.headers?.["http-referer"], "https://klio.tech");
});

test("probeEmbeddingModel sends attribution headers", async (t) => {
  t.after(restoreFetch);
  const captured: { headers?: Record<string, string> } = {};
  mockFetch(async (req) => {
    captured.headers = Object.fromEntries(req.headers.entries());
    return new Response(
      JSON.stringify({
        data: [{ embedding: new Array(8).fill(0) }],
        usage: { total_tokens: 1 },
      }),
      { status: 200 },
    );
  });
  await probeEmbeddingModel("sk-or-test", "x/y");
  assert.equal(captured.headers?.["x-title"], "Klio");
  assert.equal(captured.headers?.["http-referer"], "https://klio.tech");
});

test("probeChatModel sends attribution headers", async (t) => {
  t.after(restoreFetch);
  const captured: { headers?: Record<string, string> } = {};
  mockFetch(async (req) => {
    captured.headers = Object.fromEntries(req.headers.entries());
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { total_tokens: 1 },
      }),
      { status: 200 },
    );
  });
  await probeChatModel("sk-or-test", "x/y");
  assert.equal(captured.headers?.["x-title"], "Klio");
  assert.equal(captured.headers?.["http-referer"], "https://klio.tech");
});

test("curateEmbeddingModels filters to known-dim text->embedding, sorts by price, takes top 3", () => {
  const catalog = [
    {
      id: "voyage/voyage-3",
      architecture: { modality: "text->embedding" },
      pricing: { prompt: "0.00000006" },
    },
    {
      id: "openai/text-embedding-3-small",
      architecture: { modality: "text->embedding" },
      pricing: { prompt: "0.00000002" },
    },
    {
      id: "anthropic/claude-3-5-haiku",
      architecture: { modality: "text->text" },
      pricing: { prompt: "0.0000008" },
    },
    {
      id: "cohere/embed-multilingual-v3.0",
      architecture: { modality: "text->embedding" },
      pricing: { prompt: "0.00000011" },
    },
    {
      id: "voyage/voyage-3-lite",
      architecture: { modality: "text->embedding" },
      pricing: { prompt: "0.00000003" },
    },
    {
      id: "unknown/model",
      architecture: { modality: "text->embedding" },
      pricing: { prompt: "0.00000001" },
    },
  ];
  const out = curateEmbeddingModels(catalog);
  assert.equal(out.length, 3);
  assert.equal(out[0].id, "openai/text-embedding-3-small");
  assert.equal(out[1].id, "voyage/voyage-3");
  assert.equal(out[2].id, "cohere/embed-multilingual-v3.0");
  assert.ok(!out.some((m) => m.id === "anthropic/claude-3-5-haiku"));
  assert.ok(!out.some((m) => m.id === "voyage/voyage-3-lite"));
  assert.ok(!out.some((m) => m.id === "unknown/model"));
});

test("curateChatModels keeps known-curated names that exist + support tools", () => {
  const catalog = [
    {
      id: "anthropic/claude-3-5-haiku",
      architecture: { modality: "text->text" },
      supported_parameters: ["tools"],
      pricing: { prompt: "0.0000008", completion: "0.000004" },
    },
    {
      id: "openai/gpt-4o-mini",
      architecture: { modality: "text->text" },
      supported_parameters: ["tools"],
      pricing: { prompt: "0.00000015", completion: "0.0000006" },
    },
    {
      id: "openai/text-embedding-3-small",
      architecture: { modality: "text->embedding" },
    },
    {
      id: "anthropic/claude-3-haiku",
      architecture: { modality: "text->text" },
      supported_parameters: ["tools"],
    },
    {
      id: "google/gemini-flash-1.5",
      architecture: { modality: "text->text" },
    },
  ];
  const out = curateChatModels(catalog);
  const ids = out.map((m) => m.id);
  assert.deepEqual(
    ids.slice().sort(),
    ["anthropic/claude-3-5-haiku", "openai/gpt-4o-mini"].sort(),
  );
});

test("curateChatModels preserves curated order (Haiku first, etc.)", () => {
  const catalog = [
    {
      id: "openai/gpt-4o",
      architecture: { modality: "text->text" },
      supported_parameters: ["tools"],
    },
    {
      id: "anthropic/claude-3-5-haiku",
      architecture: { modality: "text->text" },
      supported_parameters: ["tools"],
    },
  ];
  const out = curateChatModels(catalog);
  assert.equal(out[0].id, "anthropic/claude-3-5-haiku");
  assert.equal(out[1].id, "openai/gpt-4o");
});

test("fetchModelCatalog throws on non-2xx", async (t) => {
  t.after(restoreFetch);
  mockFetch(async () => new Response("err", { status: 500 }));
  await assert.rejects(() => fetchModelCatalog("sk"), /HTTP 500/);
});
