import { strict as assert } from "node:assert";
import { test } from "node:test";

import { conversationSessionId, emitCapture } from "../src/proxy/capture.js";

const CONFIG = { apiKey: "k", agentId: "a", baseUrl: "https://api.example" };

const body = (msgs: unknown[]) => Buffer.from(JSON.stringify({ messages: msgs }));

test("session id is stable across turns of one conversation", () => {
  const first = [{ role: "user", content: "start the auth refactor" }];
  const later = [...first, { role: "assistant", content: "ok" }, { role: "user", content: "next" }];
  assert.equal(conversationSessionId("codex", first), conversationSessionId("codex", later));
});

test("different conversations get different ids", () => {
  assert.notEqual(
    conversationSessionId("codex", [{ role: "user", content: "A" }]),
    conversationSessionId("codex", [{ role: "user", content: "B" }]),
  );
});

test("session id is namespaced to the proxy and the agent", () => {
  assert.match(conversationSessionId("codex", [{ role: "user", content: "A" }]), /^klio-proxy:codex:/);
});

test("emit posts the transcript with auth headers", async () => {
  let seenUrl = "";
  let seenBody: any = null;
  let seenHeaders: any = null;
  await emitCapture({
    config: CONFIG,
    agent: "codex",
    requestBody: body([{ role: "user", content: "why postgres" }]),
    assistantText: "because of tenant isolation",
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
  assert.equal(seenBody.messages.at(-1).content, "because of tenant isolation");
  assert.match(seenBody.session_id, /^klio-proxy:codex:/);
});

test("a failing emit never throws", async () => {
  await emitCapture({
    config: CONFIG,
    agent: "codex",
    requestBody: body([{ role: "user", content: "q" }]),
    assistantText: "a",
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
