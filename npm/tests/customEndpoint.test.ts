// Tests for the custom OpenAI-compatible endpoint probes.
//
// Same `globalThis.fetch` override approach as `openrouter.test.ts`:
// each test installs a mock handler that asserts request shape (URL,
// method, headers, body) and synthesises an arbitrary `Response` for
// the function under test to consume. The original fetch is restored
// after each test so unrelated tests stay hermetic.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  probeCustomEndpoint,
  probeCustomEmbedding,
  probeCustomChat,
} from "../src/customEndpoint.js";

type FetchHandler = (req: Request) => Response | Promise<Response>;

const originalFetch = globalThis.fetch;

function mockFetch(handler: FetchHandler): () => void {
  // Cast goes through `unknown` because Node's lib types for `fetch`
  // are a union of overloads that the simpler handler shape here is
  // compatible with at runtime but not structurally assignable to.
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const req = new Request(
      ...(args as ConstructorParameters<typeof Request>),
    );
    return handler(req);
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("probeCustomEndpoint returns model list on 200", async (t) => {
  const captured: { url?: string; headers?: Record<string, string> } = {};
  const restore = mockFetch(async (req) => {
    captured.url = req.url;
    captured.headers = Object.fromEntries(req.headers.entries());
    return new Response(
      JSON.stringify({
        data: [
          { id: "text-embedding-3-small" },
          { id: "claude-3-5-haiku" },
        ],
      }),
      { status: 200 },
    );
  });
  t.after(restore);
  const info = await probeCustomEndpoint(
    "https://litellm.acme.corp/v1",
    "sk-test",
  );
  assert.equal(captured.url, "https://litellm.acme.corp/v1/models");
  assert.equal(captured.headers?.["authorization"], "Bearer sk-test");
  assert.equal(captured.headers?.["x-title"], "Klio");
  assert.equal(captured.headers?.["http-referer"], "https://klio.tech");
  assert.equal(info.modelsAvailable, 2);
  assert.deepEqual(info.modelsList, [
    "text-embedding-3-small",
    "claude-3-5-haiku",
  ]);
});

test("probeCustomEndpoint omits Authorization when key is empty", async (t) => {
  const captured: { headers?: Record<string, string> } = {};
  const restore = mockFetch(async (req) => {
    captured.headers = Object.fromEntries(req.headers.entries());
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });
  t.after(restore);
  await probeCustomEndpoint("http://localhost:4000/v1", "");
  assert.equal(captured.headers?.["authorization"], undefined);
  // Attribution headers still present.
  assert.equal(captured.headers?.["x-title"], "Klio");
  assert.equal(captured.headers?.["http-referer"], "https://klio.tech");
});

test("probeCustomEndpoint omits Authorization when key is undefined", async (t) => {
  const captured: { headers?: Record<string, string> } = {};
  const restore = mockFetch(async (req) => {
    captured.headers = Object.fromEntries(req.headers.entries());
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });
  t.after(restore);
  await probeCustomEndpoint("http://localhost:4000/v1", undefined);
  assert.equal(captured.headers?.["authorization"], undefined);
});

test("probeCustomEndpoint handles 404 as modelsList=null without throwing", async (t) => {
  const restore = mockFetch(
    async () => new Response("not found", { status: 404 }),
  );
  t.after(restore);
  const info = await probeCustomEndpoint("https://x/v1", "sk-test");
  assert.equal(info.modelsAvailable, 0);
  assert.equal(info.modelsList, null);
});

test("probeCustomEndpoint throws on 401", async (t) => {
  const restore = mockFetch(
    async () => new Response("unauthorized", { status: 401 }),
  );
  t.after(restore);
  await assert.rejects(
    () => probeCustomEndpoint("https://x/v1", "bad"),
    /Invalid key/,
  );
});

test("probeCustomEndpoint throws on 403", async (t) => {
  const restore = mockFetch(
    async () => new Response("forbidden", { status: 403 }),
  );
  t.after(restore);
  await assert.rejects(
    () => probeCustomEndpoint("https://x/v1", "weak"),
    /Forbidden/,
  );
});

test("probeCustomEndpoint throws on 5xx", async (t) => {
  const restore = mockFetch(
    async () => new Response("err", { status: 503 }),
  );
  t.after(restore);
  await assert.rejects(
    () => probeCustomEndpoint("https://x/v1", "k"),
    /unreachable/,
  );
});

test("probeCustomEndpoint strips trailing slash from base URL", async (t) => {
  const captured: { url?: string } = {};
  const restore = mockFetch(async (req) => {
    captured.url = req.url;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });
  t.after(restore);
  await probeCustomEndpoint("https://x/v1/", "sk-test");
  assert.equal(captured.url, "https://x/v1/models");
});

test("probeCustomEndpoint strips multiple trailing slashes", async (t) => {
  const captured: { url?: string } = {};
  const restore = mockFetch(async (req) => {
    captured.url = req.url;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });
  t.after(restore);
  await probeCustomEndpoint("https://x/v1///", "sk-test");
  assert.equal(captured.url, "https://x/v1/models");
});

test("probeCustomEmbedding returns dim from response", async (t) => {
  const captured: { url?: string; json?: { model: string; input: string } } =
    {};
  const restore = mockFetch(async (req) => {
    captured.url = req.url;
    captured.json = (await req.json()) as { model: string; input: string };
    return new Response(
      JSON.stringify({
        data: [{ embedding: new Array(1536).fill(0) }],
        usage: { total_tokens: 1 },
      }),
      { status: 200 },
    );
  });
  t.after(restore);
  const r = await probeCustomEmbedding(
    "https://x/v1",
    "sk",
    "text-embedding-3-small",
  );
  assert.equal(captured.url, "https://x/v1/embeddings");
  assert.equal(captured.json?.model, "text-embedding-3-small");
  assert.equal(captured.json?.input, "ok");
  assert.equal(r.dim, 1536);
  assert.equal(r.tokensUsed, 1);
});

test("probeCustomEmbedding sends attribution headers and Bearer auth", async (t) => {
  const captured: { headers?: Record<string, string> } = {};
  const restore = mockFetch(async (req) => {
    captured.headers = Object.fromEntries(req.headers.entries());
    return new Response(
      JSON.stringify({
        data: [{ embedding: new Array(8).fill(0) }],
        usage: { total_tokens: 1 },
      }),
      { status: 200 },
    );
  });
  t.after(restore);
  await probeCustomEmbedding("https://x/v1", "sk", "m");
  assert.equal(captured.headers?.["authorization"], "Bearer sk");
  assert.equal(captured.headers?.["x-title"], "Klio");
  assert.equal(captured.headers?.["http-referer"], "https://klio.tech");
});

test("probeCustomEmbedding omits Authorization when key is empty", async (t) => {
  const captured: { headers?: Record<string, string> } = {};
  const restore = mockFetch(async (req) => {
    captured.headers = Object.fromEntries(req.headers.entries());
    return new Response(
      JSON.stringify({
        data: [{ embedding: new Array(8).fill(0) }],
        usage: { total_tokens: 1 },
      }),
      { status: 200 },
    );
  });
  t.after(restore);
  await probeCustomEmbedding("http://localhost:4000/v1", "", "m");
  assert.equal(captured.headers?.["authorization"], undefined);
});

test("probeCustomEmbedding throws with provider message on non-2xx", async (t) => {
  const restore = mockFetch(
    async () =>
      new Response(JSON.stringify({ error: { message: "Model not found" } }), {
        status: 404,
      }),
  );
  t.after(restore);
  await assert.rejects(
    () => probeCustomEmbedding("https://x/v1", "k", "made-up"),
    /Model not found/,
  );
});

test("probeCustomEmbedding falls back to generic error when no body message", async (t) => {
  const restore = mockFetch(
    async () => new Response("", { status: 500 }),
  );
  t.after(restore);
  await assert.rejects(
    () => probeCustomEmbedding("https://x/v1", "k", "m"),
    /Model probe failed \(HTTP 500\)/,
  );
});

test("probeCustomChat returns response time", async (t) => {
  const restore = mockFetch(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { total_tokens: 4 },
        }),
        { status: 200 },
      ),
  );
  t.after(restore);
  const r = await probeCustomChat("https://x/v1", "sk", "gpt-4o-mini");
  assert.equal(r.tokensUsed, 4);
  assert.ok(r.latencyMs >= 0);
});

test("probeCustomChat sends attribution headers and Bearer auth", async (t) => {
  const captured: {
    url?: string;
    headers?: Record<string, string>;
    json?: { model: string; messages: { role: string; content: string }[]; max_tokens: number };
  } = {};
  const restore = mockFetch(async (req) => {
    captured.url = req.url;
    captured.headers = Object.fromEntries(req.headers.entries());
    captured.json = (await req.json()) as {
      model: string;
      messages: { role: string; content: string }[];
      max_tokens: number;
    };
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { total_tokens: 1 },
      }),
      { status: 200 },
    );
  });
  t.after(restore);
  await probeCustomChat("https://x/v1", "sk", "gpt-4o-mini");
  assert.equal(captured.url, "https://x/v1/chat/completions");
  assert.equal(captured.headers?.["authorization"], "Bearer sk");
  assert.equal(captured.headers?.["x-title"], "Klio");
  assert.equal(captured.headers?.["http-referer"], "https://klio.tech");
  assert.equal(captured.json?.model, "gpt-4o-mini");
  assert.deepEqual(captured.json?.messages, [{ role: "user", content: "ok" }]);
  assert.equal(captured.json?.max_tokens, 1);
});

test("probeCustomChat omits Authorization when key is empty", async (t) => {
  const captured: { headers?: Record<string, string> } = {};
  const restore = mockFetch(async (req) => {
    captured.headers = Object.fromEntries(req.headers.entries());
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { total_tokens: 1 },
      }),
      { status: 200 },
    );
  });
  t.after(restore);
  await probeCustomChat("http://localhost:4000/v1", "", "m");
  assert.equal(captured.headers?.["authorization"], undefined);
});

test("probeCustomChat tolerates missing usage block (tokensUsed=0)", async (t) => {
  const restore = mockFetch(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" } }],
        }),
        { status: 200 },
      ),
  );
  t.after(restore);
  const r = await probeCustomChat("https://x/v1", "k", "m");
  assert.equal(r.tokensUsed, 0);
});

test("probeCustomChat throws with provider message on non-2xx", async (t) => {
  const restore = mockFetch(
    async () =>
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
      }),
  );
  t.after(restore);
  await assert.rejects(
    () => probeCustomChat("https://x/v1", "k", "m"),
    /rate limited/,
  );
});
