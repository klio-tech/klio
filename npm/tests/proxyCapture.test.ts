import { strict as assert } from "node:assert";
import { test } from "node:test";

import { conversationSessionId, emitCapture } from "../src/proxy/capture.js";

const CONFIG = { apiKey: "k", agentId: "a", baseUrl: "https://api.example" };

const body = (msgs: unknown[]) => Buffer.from(JSON.stringify({ messages: msgs }));

test("session id is null when history contains no assistant turn yet (turn 1 is skipped)", () => {
  const first = [{ role: "user", content: "start the auth refactor" }];
  assert.equal(conversationSessionId("codex", first), null);
});

test("two conversations with identical first user message but different assistant replies get DIFFERENT ids", () => {
  const conv1 = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "reply A" },
  ];
  const conv2 = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "reply B" },
  ];
  assert.notEqual(
    conversationSessionId("codex", conv1),
    conversationSessionId("codex", conv2),
  );
});

test("same conversation at turns 2, 3, and 8 gets the same id", () => {
  const turn2 = [
    { role: "user", content: "start the auth refactor" },
    { role: "assistant", content: "ok" },
  ];
  const turn3 = [
    ...turn2,
    { role: "user", content: "next" },
    { role: "assistant", content: "sure" },
  ];
  const turn8 = [
    ...turn3,
    { role: "user", content: "more" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "continue" },
    { role: "assistant", content: "continuing" },
    { role: "user", content: "final" },
  ];
  const id2 = conversationSessionId("codex", turn2);
  const id3 = conversationSessionId("codex", turn3);
  const id8 = conversationSessionId("codex", turn8);
  assert.ok(id2, "turn 2 should have an id");
  assert.equal(id2, id3, "turns 2 and 3 should have same id");
  assert.equal(id3, id8, "turns 3 and 8 should have same id");
});

test("session id is namespaced to the proxy and the agent", () => {
  const msgs = [
    { role: "user", content: "A" },
    { role: "assistant", content: "B" },
  ];
  assert.match(conversationSessionId("codex", msgs)!, /^klio-proxy:codex:/);
});

test("emit posts the transcript with auth headers", async () => {
  let seenUrl = "";
  let seenBody: any = null;
  let seenHeaders: any = null;
  await emitCapture({
    config: CONFIG,
    agent: "codex",
    requestBody: body([
      { role: "user", content: "why postgres" },
      { role: "assistant", content: "because of tenant isolation" },
    ]),
    assistantText: "and replication",
    fetchImpl: (async (url: any, init: any) => {
      seenUrl = String(url);
      seenHeaders = init.headers;
      seenBody = JSON.parse(init.body);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.match(seenUrl, /\/capture\/transcript$/);
  assert.equal(seenHeaders["X-Vex-Key"], "k");
  assert.equal(seenBody.messages.at(-1).role, "assistant");
  assert.equal(seenBody.messages.at(-1).content, "and replication");
  assert.match(seenBody.session_id, /^klio-proxy:codex:/);
});

test("single-user-message request (turn 1) is skipped, no capture POST issued", async () => {
  let called = false;
  await emitCapture({
    config: CONFIG,
    agent: "codex",
    requestBody: body([{ role: "user", content: "q" }]),
    assistantText: "a",
    fetchImpl: (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch,
  });
  assert.equal(called, false);
});

test("a failing emit never throws", async () => {
  await emitCapture({
    config: CONFIG,
    agent: "codex",
    requestBody: body([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]),
    assistantText: "more",
    fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch,
  });
  // reaching here without throwing is the assertion
  assert.ok(true);
});

test("an unparseable request body is skipped silently", async () => {
  let called = false;
  await emitCapture({
    config: CONFIG,
    agent: "codex",
    requestBody: Buffer.from("nonsense"),
    assistantText: "a",
    fetchImpl: (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch,
  });
  assert.equal(called, false);
});

test("tool_use and tool_result blocks are rendered in the transcript", async () => {
  let seenBody: any = null;
  await emitCapture({
    config: CONFIG,
    agent: "codex",
    requestBody: body([
      { role: "user", content: "test" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll read the file" },
          { type: "tool_use", name: "Read", id: "tool_1", input: { path: "/tmp/file" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool_1", content: "file contents" }],
      },
    ]),
    assistantText: "done",
    fetchImpl: (async (url: any, init: any) => {
      seenBody = JSON.parse(init.body);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  const transcript = seenBody.messages.map((m: any) => m.content).join(" | ");
  assert.match(transcript, /tool_use/, "should contain tool_use marker");
  assert.match(transcript, /Read/, "should contain tool name");
  assert.match(transcript, /tool_result/, "should contain tool_result marker");
  assert.match(transcript, /file contents/, "should contain tool result content");
});
