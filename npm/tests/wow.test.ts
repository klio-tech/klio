import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runWowMoment } from "../src/wow.js";

type RecordedCall = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
};

/**
 * Build a fetch mock that handles the two calls runWowMoment makes:
 *   1. POST /v1/spaces/{id}/entries  → { id }
 *   2. POST /v1/spaces/{id}/recall   → [ EntryResponse, ... ]
 *
 * The token exchange happens in init.ts BEFORE runWowMoment is
 * called (to avoid the bridge-rotation race), so wow.ts itself
 * never touches /v1/tokens/refresh.
 */
function buildMockFetch(
  scenario: { writtenID: string; recallTopID: string },
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
    if (u.endsWith("/entries")) {
      return new Response(JSON.stringify({ id: scenario.writtenID }), {
        status: 201,
      });
    }
    // recall returns a flat list of EntryResponse — no `results` wrapper,
    // no `score` field.
    return new Response(
      JSON.stringify([
        {
          id: scenario.recallTopID,
          space_id: "sp1",
          agent_id: "ag1",
          kind: "memory",
          content: "I'm Abhishek",
          confidence: 1,
          created_at: new Date().toISOString(),
        },
      ]),
      { status: 200 },
    );
  }) as typeof fetch;
}

test("runWowMoment posts the memory and validates recall", async () => {
  const calls: RecordedCall[] = [];
  const mockFetch = buildMockFetch(
    { writtenID: "7a2c-fake", recallTopID: "7a2c-fake" },
    calls,
  );

  const result = await runWowMoment({
    engineURL: "http://localhost:8000",
    accessToken: "access-jwt-fake",
    spaceID: "space-id",
    promptFn: async () => "I'm Abhishek, building Klio",
    log: () => {},
    waitEnter: async () => {},
    fetchFn: mockFetch,
  });

  assert.equal(result.entryID, "7a2c-fake");
  assert.equal(result.recallScore, 1.0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://localhost:8000/v1/spaces/space-id/entries");
  assert.equal(calls[1].url, "http://localhost:8000/v1/spaces/space-id/recall");
});

test("runWowMoment uses the provided access token as Bearer on both calls", async () => {
  const calls: RecordedCall[] = [];
  const mockFetch = buildMockFetch(
    { writtenID: "abc-123", recallTopID: "abc-123" },
    calls,
  );

  await runWowMoment({
    engineURL: "http://engine.test",
    accessToken: "jwt-access-token",
    spaceID: "sp1",
    promptFn: async () => "remember this",
    log: () => {},
    waitEnter: async () => {},
    fetchFn: mockFetch,
  });

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.method, "POST");
    assert.equal(call.headers?.Authorization, "Bearer jwt-access-token");
    assert.equal(call.headers?.["Content-Type"], "application/json");
  }

  // entries write: kind=memory, no space_id (in URL), correct content
  const writeBody = calls[0].body as Record<string, unknown>;
  assert.equal(writeBody.space_id, undefined);
  assert.equal(writeBody.kind, "memory");
  assert.equal(writeBody.content, "remember this");
  assert.equal(writeBody.confidence, 1);
  assert.deepEqual(writeBody.metadata, { source: "klio init wow moment" });

  // recall body
  const recallBody = calls[1].body as Record<string, unknown>;
  assert.equal(recallBody.query, "what should you remember about me");
  assert.equal(recallBody.limit, 1);
});

test("runWowMoment requests multiline input from the prompt", async () => {
  const calls: RecordedCall[] = [];
  const mockFetch = buildMockFetch(
    { writtenID: "id-1", recallTopID: "id-1" },
    calls,
  );
  let observedMultiline: boolean | undefined;

  await runWowMoment({
    engineURL: "http://e",
    accessToken: "t",
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
  const mockFetch = buildMockFetch(
    { writtenID: "written-id", recallTopID: "different-id" },
    calls,
  );

  const result = await runWowMoment({
    engineURL: "http://e",
    accessToken: "t",
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
        accessToken: "t",
        spaceID: "s",
        promptFn: async () => "x",
        log: () => {},
        waitEnter: async () => {},
        fetchFn: mockFetch,
      }),
    /store memory failed/,
  );
});
