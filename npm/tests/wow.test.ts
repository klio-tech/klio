import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runWowMoment } from "../src/wow.js";

type RecordedCall = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
};

function buildMockFetch(
  recall: { id: string; score: number },
  recordedCalls: RecordedCall[],
): typeof fetch {
  return (async (url, init) => {
    const u = url.toString();
    const headers = init?.headers as Record<string, string> | undefined;
    const body =
      init?.body !== undefined
        ? JSON.parse(init.body as string)
        : undefined;
    recordedCalls.push({ url: u, method: init?.method, headers, body });
    if (u.endsWith("/v1/entries")) {
      return new Response(JSON.stringify({ id: recall.id }), { status: 201 });
    }
    return new Response(
      JSON.stringify({
        results: [
          { id: recall.id, content: "I'm Abhishek", score: recall.score },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

test("runWowMoment posts the memory and validates recall", async () => {
  const calls: RecordedCall[] = [];
  const mockFetch = buildMockFetch({ id: "7a2c-fake", score: 0.92 }, calls);

  const result = await runWowMoment({
    engineURL: "http://localhost:8000",
    refreshToken: "rt",
    spaceID: "space-id",
    promptFn: async () => "I'm Abhishek, building Klio",
    log: () => {},
    waitEnter: async () => {},
    fetchFn: mockFetch,
  });

  assert.equal(result.entryID, "7a2c-fake");
  assert.equal(result.recallScore, 0.92);
  assert.equal(calls.length, 2);
});

test("runWowMoment uses Bearer auth on both POSTs", async () => {
  const calls: RecordedCall[] = [];
  const mockFetch = buildMockFetch({ id: "abc-123", score: 0.5 }, calls);

  await runWowMoment({
    engineURL: "http://engine.test",
    refreshToken: "shhh-token",
    spaceID: "sp1",
    promptFn: async () => "remember this",
    log: () => {},
    waitEnter: async () => {},
    fetchFn: mockFetch,
  });

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.method, "POST");
    assert.equal(call.headers?.Authorization, "Bearer shhh-token");
    assert.equal(call.headers?.["Content-Type"], "application/json");
  }

  // first call: write entry — sanity check the body
  assert.equal(calls[0].url, "http://engine.test/v1/entries");
  const writeBody = calls[0].body as Record<string, unknown>;
  assert.equal(writeBody.space_id, "sp1");
  assert.equal(writeBody.kind, "preference");
  assert.equal(writeBody.content, "remember this");
  assert.equal(writeBody.confidence, 1);
  assert.deepEqual(writeBody.metadata, { source: "klio init wow moment" });

  // second call: recall
  assert.equal(calls[1].url, "http://engine.test/v1/spaces/sp1/recall");
  const recallBody = calls[1].body as Record<string, unknown>;
  assert.equal(recallBody.query, "what should you remember about me");
  assert.equal(recallBody.limit, 1);
});

test("runWowMoment requests multiline input from the prompt", async () => {
  const calls: RecordedCall[] = [];
  const mockFetch = buildMockFetch({ id: "id-1", score: 0.7 }, calls);
  let observedMultiline: boolean | undefined;

  await runWowMoment({
    engineURL: "http://e",
    refreshToken: "t",
    spaceID: "s",
    promptFn: async (opts) => {
      observedMultiline = opts.multiline;
      return "x";
    },
    log: () => {},
    waitEnter: async () => {},
    fetchFn: mockFetch,
  });

  assert.equal(observedMultiline, true);
});

test("runWowMoment proceeds with a warning when recall returns a different id", async () => {
  const logged: string[] = [];
  const calls: RecordedCall[] = [];
  const mockFetch = (async (url, init) => {
    const u = url.toString();
    const body =
      init?.body !== undefined
        ? JSON.parse(init.body as string)
        : undefined;
    calls.push({ url: u, body });
    if (u.endsWith("/v1/entries")) {
      return new Response(JSON.stringify({ id: "written-id" }), {
        status: 201,
      });
    }
    return new Response(
      JSON.stringify({ results: [{ id: "different-id", score: 0.4 }] }),
      { status: 200 },
    );
  }) as typeof fetch;

  const result = await runWowMoment({
    engineURL: "http://e",
    refreshToken: "t",
    spaceID: "s",
    promptFn: async () => "memory",
    log: (l) => logged.push(l),
    waitEnter: async () => {},
    fetchFn: mockFetch,
  });

  assert.equal(result.entryID, "written-id");
  assert.equal(result.recallScore, 0);
  const joined = logged.join("\n");
  assert.match(joined, /different top entry/);
});

test("runWowMoment throws when the write call fails", async () => {
  const mockFetch = (async () => {
    return new Response("nope", { status: 500 });
  }) as typeof fetch;

  await assert.rejects(
    () =>
      runWowMoment({
        engineURL: "http://e",
        refreshToken: "t",
        spaceID: "s",
        promptFn: async () => "x",
        log: () => {},
        waitEnter: async () => {},
        fetchFn: mockFetch,
      }),
    /store memory failed/,
  );
});
