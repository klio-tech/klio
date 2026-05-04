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
 * Build a fetch mock that handles the three calls runWowMoment makes
 * in order:
 *   1. POST /v1/tokens/refresh           → { access_token, refresh_token }
 *   2. POST /v1/spaces/{id}/entries      → { id }
 *   3. POST /v1/spaces/{id}/recall       → [ EntryResponse, ... ]
 *
 * Tests inject the entryID + the recall top-result id so we can
 * exercise the match-and-mismatch branches.
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
    if (u.endsWith("/v1/tokens/refresh")) {
      return new Response(
        JSON.stringify({
          access_token: "access-jwt-fake",
          refresh_token: "rotated-refresh-fake",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }
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

test("runWowMoment exchanges refresh token, posts memory, validates recall", async () => {
  const calls: RecordedCall[] = [];
  const mockFetch = buildMockFetch(
    { writtenID: "7a2c-fake", recallTopID: "7a2c-fake" },
    calls,
  );

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
  assert.equal(result.recallScore, 1.0);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "http://localhost:8000/v1/tokens/refresh");
  assert.equal(calls[1].url, "http://localhost:8000/v1/spaces/space-id/entries");
  assert.equal(calls[2].url, "http://localhost:8000/v1/spaces/space-id/recall");
});

test("runWowMoment uses access token (not refresh) as Bearer on entries + recall", async () => {
  const calls: RecordedCall[] = [];
  const mockFetch = buildMockFetch(
    { writtenID: "abc-123", recallTopID: "abc-123" },
    calls,
  );

  await runWowMoment({
    engineURL: "http://engine.test",
    refreshToken: "shhh-refresh-token",
    spaceID: "sp1",
    promptFn: async () => "remember this",
    log: () => {},
    waitEnter: async () => {},
    fetchFn: mockFetch,
  });

  assert.equal(calls.length, 3);

  // First call: token exchange — no Authorization header (the body
  // carries the refresh token).
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers?.Authorization, undefined);
  assert.equal((calls[0].body as Record<string, unknown>).refresh_token, "shhh-refresh-token");

  // Subsequent calls: access token in Bearer, NOT refresh.
  for (const call of calls.slice(1)) {
    assert.equal(call.method, "POST");
    assert.equal(call.headers?.Authorization, "Bearer access-jwt-fake");
    assert.equal(call.headers?.["Content-Type"], "application/json");
  }

  // entries write body: kind=memory, no space_id (in URL), correct content
  const writeBody = calls[1].body as Record<string, unknown>;
  assert.equal(writeBody.space_id, undefined);
  assert.equal(writeBody.kind, "memory");
  assert.equal(writeBody.content, "remember this");
  assert.equal(writeBody.confidence, 1);
  assert.deepEqual(writeBody.metadata, { source: "klio init wow moment" });

  // recall body
  const recallBody = calls[2].body as Record<string, unknown>;
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
  const mockFetch = buildMockFetch(
    { writtenID: "written-id", recallTopID: "different-id" },
    calls,
  );

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

test("runWowMoment throws when the token exchange fails", async () => {
  const mockFetch = (async (url) => {
    if (url.toString().endsWith("/v1/tokens/refresh")) {
      return new Response("unauthorized", { status: 401 });
    }
    throw new Error("should not reach beyond exchange");
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
    /token exchange failed/,
  );
});

test("runWowMoment throws when the write call fails", async () => {
  const mockFetch = (async (url) => {
    if (url.toString().endsWith("/v1/tokens/refresh")) {
      return new Response(
        JSON.stringify({
          access_token: "a",
          refresh_token: "b",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }
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
