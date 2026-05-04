// Tests for the Ollama daemon detection + model listing helpers.
//
// We override `globalThis.fetch` for the duration of each test using
// the same pattern as `openrouter.test.ts`. The real daemon never
// runs in CI, so every code path here is exercised through synthetic
// `Response` objects.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  filterToSupportedEmbed,
  isOllamaRunning,
  listInstalledModels,
  type OllamaModel,
} from "../src/ollama.js";

type FetchHandler = (req: Request) => Response | Promise<Response>;

const originalFetch = globalThis.fetch;

function mockFetch(handler: FetchHandler): () => void {
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

test("isOllamaRunning returns true when /api/tags responds 200", async (t) => {
  const restore = mockFetch(
    async () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
  );
  t.after(restore);
  assert.equal(await isOllamaRunning(), true);
});

test("isOllamaRunning returns false on connection refused", async (t) => {
  const restore = mockFetch(async () => {
    throw new Error("ECONNREFUSED");
  });
  t.after(restore);
  assert.equal(await isOllamaRunning(), false);
});

test("isOllamaRunning returns false on non-2xx", async (t) => {
  const restore = mockFetch(
    async () => new Response("nope", { status: 500 }),
  );
  t.after(restore);
  assert.equal(await isOllamaRunning(), false);
});

test("listInstalledModels returns name + size from /api/tags", async (t) => {
  const restore = mockFetch(
    async () =>
      new Response(
        JSON.stringify({
          models: [
            { name: "nomic-embed-text:latest", size: 274_000_000 },
            { name: "llama3.1:8b", size: 4_700_000_000 },
          ],
        }),
        { status: 200 },
      ),
  );
  t.after(restore);
  const out = await listInstalledModels();
  assert.deepEqual(out, [
    { name: "nomic-embed-text:latest", size: 274_000_000 },
    { name: "llama3.1:8b", size: 4_700_000_000 },
  ]);
});

test("listInstalledModels returns [] on missing models field", async (t) => {
  const restore = mockFetch(
    async () => new Response(JSON.stringify({}), { status: 200 }),
  );
  t.after(restore);
  assert.deepEqual(await listInstalledModels(), []);
});

test("listInstalledModels throws on non-2xx response", async (t) => {
  const restore = mockFetch(
    async () => new Response("err", { status: 500 }),
  );
  t.after(restore);
  await assert.rejects(() => listInstalledModels(), /HTTP 500/);
});

test("filterToSupportedEmbed keeps only known-dim models, sans tag", () => {
  const all: OllamaModel[] = [
    { name: "nomic-embed-text:latest", size: 1 },
    { name: "llama3.1:8b", size: 1 },
    { name: "snowflake-arctic-embed2:l", size: 1 },
    { name: "bge-m3", size: 1 },
    { name: "phi3:mini", size: 1 },
  ];
  const out = filterToSupportedEmbed(all);
  const names = out.map((m) => m.name);
  assert(names.includes("nomic-embed-text:latest"));
  assert(names.includes("snowflake-arctic-embed2:l"));
  assert(names.includes("bge-m3"));
  assert(!names.includes("llama3.1:8b"));
  assert(!names.includes("phi3:mini"));
});
