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
  pullOllamaModel,
  type OllamaModel,
  type SpawnedProcess,
  type Spawner,
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

// Build a fake child whose `exit`/`error`/`stderr.data` handlers are
// captured into the supplied refs. The test then drives the state
// machine by invoking those callbacks on demand, simulating both
// well-behaved exits and faults without forking a real subprocess.
type ChildRefs = {
  exit?: (code: number | null) => void;
  error?: (err: Error) => void;
  stderrData?: (chunk: Buffer) => void;
  cmd?: string;
  args?: string[];
};

function fakeSpawner(refs: ChildRefs): Spawner {
  return (cmd: string, args: string[]): SpawnedProcess => {
    refs.cmd = cmd;
    refs.args = args;
    return {
      stderr: {
        on(event: "data", cb: (chunk: Buffer) => void) {
          if (event === "data") refs.stderrData = cb;
        },
      },
      on(event: "exit" | "error", cb: (arg: never) => void) {
        if (event === "exit") {
          refs.exit = cb as unknown as (code: number | null) => void;
        } else if (event === "error") {
          refs.error = cb as unknown as (err: Error) => void;
        }
      },
    };
  };
}

test("pullOllamaModel resolves on exit code 0", async () => {
  const refs: ChildRefs = {};
  const promise = pullOllamaModel(
    "nomic-embed-text",
    () => {},
    fakeSpawner(refs),
  );
  setImmediate(() => refs.exit?.(0));
  await promise;
  assert.equal(refs.cmd, "ollama");
  assert.deepEqual(refs.args, ["pull", "nomic-embed-text"]);
});

test("pullOllamaModel rejects on non-zero exit", async () => {
  const refs: ChildRefs = {};
  const promise = pullOllamaModel(
    "nomic-embed-text",
    () => {},
    fakeSpawner(refs),
  );
  setImmediate(() => refs.exit?.(1));
  await assert.rejects(promise, /exited 1/);
});

test("pullOllamaModel rejects when spawn errors", async () => {
  const refs: ChildRefs = {};
  const promise = pullOllamaModel("x", () => {}, fakeSpawner(refs));
  setImmediate(() => refs.error?.(new Error("ENOENT: ollama not found")));
  await assert.rejects(promise, /ENOENT/);
});

test("pullOllamaModel forwards stderr lines to onProgress", async () => {
  const refs: ChildRefs = {};
  const lines: string[] = [];
  const promise = pullOllamaModel(
    "x",
    (line) => lines.push(line),
    fakeSpawner(refs),
  );
  setImmediate(() => {
    refs.stderrData?.(Buffer.from("pulling manifest\n"));
    refs.stderrData?.(Buffer.from("pulling abc123: 100%\n"));
    refs.exit?.(0);
  });
  await promise;
  assert(lines.includes("pulling manifest"));
  assert(lines.includes("pulling abc123: 100%"));
});

test("pullOllamaModel skips empty stderr lines", async () => {
  const refs: ChildRefs = {};
  const lines: string[] = [];
  const promise = pullOllamaModel(
    "x",
    (line) => lines.push(line),
    fakeSpawner(refs),
  );
  setImmediate(() => {
    refs.stderrData?.(Buffer.from("\n\nreal line\n   \n"));
    refs.exit?.(0);
  });
  await promise;
  assert.deepEqual(lines, ["real line"]);
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
