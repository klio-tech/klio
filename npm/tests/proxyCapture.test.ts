import { strict as assert } from "node:assert";
import { test } from "node:test";

import { conversationSessionId, emitCapture, renderBlock } from "../src/proxy/capture.js";

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

test("per-block 8000-char truncation: long tool_use input is truncated with …[truncated] suffix", async () => {
  const longInput = { data: "x".repeat(10000) };
  let seenBody: any = null;
  await emitCapture({
    config: CONFIG,
    agent: "codex",
    requestBody: body([
      { role: "user", content: "test" },
      {
        role: "assistant",
        content: [{ type: "tool_use", name: "Process", id: "t1", input: longInput }],
      },
    ]),
    assistantText: "ok",
    fetchImpl: (async (url: any, init: any) => {
      seenBody = JSON.parse(init.body);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  const content = seenBody.messages[1].content;
  assert.match(content, /…\[truncated\]/, "should contain truncation marker");
  assert.ok(content.length < 10000, "truncated content should be shorter than original");
});

test("per-block 8000-char truncation: long tool_result content is truncated with …[truncated] suffix", async () => {
  const longContent = "y".repeat(10000);
  let seenBody: any = null;
  await emitCapture({
    config: CONFIG,
    agent: "codex",
    requestBody: body([
      { role: "user", content: "test" },
      { role: "assistant", content: "calling tool" },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: longContent }],
      },
    ]),
    assistantText: "done",
    fetchImpl: (async (url: any, init: any) => {
      seenBody = JSON.parse(init.body);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  const content = seenBody.messages[2].content;
  assert.match(content, /…\[truncated\]/, "should contain truncation marker");
  assert.ok(content.length < 10000, "truncated content should be shorter than original");
});

test("array-form tool_result.content recursion: nested blocks are rendered", async () => {
  let seenBody: any = null;
  await emitCapture({
    config: CONFIG,
    agent: "codex",
    requestBody: body([
      { role: "user", content: "test" },
      { role: "assistant", content: "calling tool" },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "part 1" },
              { type: "text", text: "part 2" },
            ],
          },
        ],
      },
    ]),
    assistantText: "done",
    fetchImpl: (async (url: any, init: any) => {
      seenBody = JSON.parse(init.body);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  const content = seenBody.messages[2].content;
  assert.match(content, /part 1/, "should render first nested block");
  assert.match(content, /part 2/, "should render second nested block");
});

test("renderBlock with circular reference returns safe string without throwing", () => {
  // Create a circular object that JSON.stringify cannot handle.
  const circularObj: any = { a: 1 };
  circularObj.self = circularObj;

  // renderBlock should catch the error and return a safe string.
  const result = renderBlock({
    type: "tool_use",
    name: "BadTool",
    id: "t1",
    input: circularObj,
  });

  assert.match(result, /\[tool_use: BadTool\]/, "should contain tool_use marker");
  assert.match(result, /\[unserializable input\]/, "should indicate unserializable input");
  assert.ok(typeof result === "string", "should return a string");
});

test("renderBlock with BigInt input returns safe string without throwing", () => {
  // BigInt cannot be JSON.stringify'd.
  const bigIntInput = BigInt("9999999999999999999999999999");

  const result = renderBlock({
    type: "tool_use",
    name: "MathTool",
    id: "t1",
    input: bigIntInput,
  });

  assert.match(result, /\[tool_use: MathTool\]/, "should contain tool_use marker");
  assert.match(result, /\[unserializable input\]/, "should indicate unserializable input");
  assert.ok(typeof result === "string", "should return a string");
});

test("total transcript payload cap: large history is truncated to fit within 256 KB", async () => {
  // Create a history large enough to exceed 256 KB with ASCII content.
  const messages: unknown[] = [];
  messages.push({ role: "user", content: "start" });
  messages.push({ role: "assistant", content: "ok" });

  // Add many large turns to definitely exceed the cap.
  for (let i = 0; i < 100; i++) {
    messages.push({ role: "user", content: "u".repeat(3000) });
    messages.push({ role: "assistant", content: "a".repeat(3000) });
  }

  let seenBody: any = null;
  let seenBodyStr = "";
  await emitCapture({
    config: CONFIG,
    agent: "codex",
    requestBody: body(messages),
    assistantText: "final response",
    fetchImpl: (async (url: any, init: any) => {
      seenBodyStr = init.body;
      seenBody = JSON.parse(init.body);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });

  // Payload should be under 256 KB (measured in UTF-8 bytes, not string length)
  const payloadBytes = Buffer.byteLength(seenBodyStr, "utf8");
  assert.ok(payloadBytes < 256 * 1024, `payload ${payloadBytes} bytes should be under 256 KB`);

  // Newest turn should survive (the final assistant message added by emitCapture)
  const hasFinal = seenBody.messages.some((m: any) => m.content && m.content.includes("final"));
  assert.ok(hasFinal, "newest assistant turn should be in transcript");

  // Elision marker should be present (since we dropped early turns)
  const hasElisionMarker = seenBody.messages.some(
    (m: any) => m.role === "system" && m.content && m.content.includes("elided")
  );
  assert.ok(hasElisionMarker, "should have elision marker when turns are dropped");

  // Most messages should be dropped
  assert.ok(seenBody.messages.length < 100, "should have dropped many messages to fit under cap");
});

const MAX_TRANSCRIPT_BYTES = 256 * 1024;

/** Capture the exact string handed to fetch, so the assertion sees what ships. */
async function capturePayload(
  messages: unknown[],
  assistantText: string,
): Promise<{ raw: string; parsed: any; called: boolean }> {
  let raw = "";
  let called = false;
  await emitCapture({
    config: CONFIG,
    agent: "codex",
    requestBody: body(messages),
    assistantText,
    fetchImpl: (async (_url: any, init: any) => {
      called = true;
      raw = String(init.body);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { raw, parsed: raw === "" ? null : JSON.parse(raw), called };
}

/** Concatenated conversation text, excluding the synthetic system elision marker. */
function conversationText(parsed: any): string {
  return parsed.messages
    .filter((m: any) => m.role !== "system")
    .map((m: any) => String(m.content ?? ""))
    .join("\n");
}

test("oversized newest USER turn is kept and truncated, never emptied", async () => {
  const huge = "U".repeat(300 * 1024);
  const { raw, parsed, called } = await capturePayload(
    [
      { role: "user", content: "start" },
      { role: "assistant", content: "ok" },
      { role: "user", content: huge },
    ],
    "", // no trailing assistant text, so the oversized user turn is newest
  );

  assert.equal(called, true, "capture should still be attempted");
  assert.ok(
    Buffer.byteLength(raw, "utf8") <= MAX_TRANSCRIPT_BYTES,
    `payload ${Buffer.byteLength(raw, "utf8")} bytes must be within the cap`,
  );
  const text = conversationText(parsed);
  assert.ok(text.includes("UUUUUUUUUU"), "the oversized user turn's content must survive truncated");
  assert.ok(text.length > 1000, "payload must not be content-empty");
});

test("oversized newest ASSISTANT turn is kept and truncated, never emptied", async () => {
  const huge = "A".repeat(300 * 1024);
  const { raw, parsed, called } = await capturePayload(
    [
      { role: "user", content: "start" },
      { role: "assistant", content: "ok" },
    ],
    huge, // the model's own oversized response is the newest turn
  );

  assert.equal(called, true, "capture should still be attempted");
  assert.ok(
    Buffer.byteLength(raw, "utf8") <= MAX_TRANSCRIPT_BYTES,
    `payload ${Buffer.byteLength(raw, "utf8")} bytes must be within the cap`,
  );
  assert.ok(parsed.messages.length > 0, "transcript must not be empty");
  const text = conversationText(parsed);
  assert.ok(text.includes("AAAAAAAAAA"), "the oversized assistant turn's content must survive truncated");
  assert.ok(text.length > 1000, "payload must not be content-empty");
});

test("a mid-exchange cut leaves a non-empty transcript that begins at a user turn", async () => {
  // Sweep turn sizes so the cut lands on both parities of the exchange.
  for (let size = 2000; size < 2020; size++) {
    const messages: unknown[] = [];
    for (let i = 0; i < 120; i++) {
      messages.push({ role: "user", content: `q${i} ` + "u".repeat(size) });
      messages.push({ role: "assistant", content: `a${i} ` + "a".repeat(size) });
    }

    const { raw, parsed } = await capturePayload(messages, "final answer");

    assert.ok(
      Buffer.byteLength(raw, "utf8") <= MAX_TRANSCRIPT_BYTES,
      `size ${size}: payload ${Buffer.byteLength(raw, "utf8")} bytes must be within the cap`,
    );
    const conversation = parsed.messages.filter((m: any) => m.role !== "system");
    assert.ok(conversation.length > 0, `size ${size}: transcript must not be empty after a cut`);
    assert.equal(conversation[0].role, "user", `size ${size}: transcript must begin at a user turn`);
  }
});

test("the elision marker cannot push the payload past the cap", async () => {
  // Many tiny turns: the loop fills right up to the cap, then the marker is added.
  const messages: unknown[] = [];
  for (let i = 0; i < 6000; i++) {
    messages.push({ role: "user", content: `u${i}-` + "x".repeat(10) });
    messages.push({ role: "assistant", content: `a${i}-` + "y".repeat(10) });
  }

  const { raw, parsed } = await capturePayload(messages, "done");

  const bytes = Buffer.byteLength(raw, "utf8");
  assert.ok(bytes <= MAX_TRANSCRIPT_BYTES, `payload ${bytes} bytes must be within the cap`);
  assert.ok(parsed.messages.length > 0, "transcript must not be empty");
});

test("truncation never splits a surrogate pair", async () => {
  const huge = "\u{1F600}".repeat(150_000);
  const { raw, parsed } = await capturePayload(
    [
      { role: "user", content: "start" },
      { role: "assistant", content: "ok" },
    ],
    huge,
  );

  const bytes = Buffer.byteLength(raw, "utf8");
  assert.ok(bytes <= MAX_TRANSCRIPT_BYTES, `payload ${bytes} bytes must be within the cap`);

  // The wire form must not carry escaped lone surrogates.
  assert.ok(
    !/\\u[dD][89abAB][0-9a-fA-F]{2}/.test(raw),
    "serialized payload must not contain escaped lone surrogates",
  );

  // And the decoded content must contain no unpaired surrogate code unit.
  const text = conversationText(parsed);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, `lone high surrogate at index ${i}`);
      i++;
    } else {
      assert.ok(!(code >= 0xdc00 && code <= 0xdfff), `lone low surrogate at index ${i}`);
    }
  }
  assert.ok(text.includes("\u{1F600}"), "truncated content must still carry whole emoji");
});

test("total transcript payload cap: multi-byte content is measured in UTF-8 bytes not .length", async () => {
  // Create a history with multi-byte content to verify byte-level measurement.
  // This test verifies the fix for Critical 1: using Buffer.byteLength instead of .length.
  const messages: unknown[] = [];
  messages.push({ role: "user", content: "start" });
  messages.push({ role: "assistant", content: "ok" });

  // Add turns with Chinese characters (each ~3 bytes in UTF-8).
  // "中".repeat(1000) is 1000 chars but ~3000 bytes, so will trigger truncation
  // at the byte level.
  for (let i = 0; i < 80; i++) {
    messages.push({ role: "user", content: "中".repeat(1000) });
    messages.push({ role: "assistant", content: "文".repeat(1000) });
  }

  let seenBody: any = null;
  let seenBodyStr = "";
  await emitCapture({
    config: CONFIG,
    agent: "codex",
    requestBody: body(messages),
    assistantText: "完成",
    fetchImpl: (async (url: any, init: any) => {
      seenBodyStr = init.body;
      seenBody = JSON.parse(init.body);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });

  // Payload must be under 256 KB (byte-level measurement)
  const payloadBytes = Buffer.byteLength(seenBodyStr, "utf8");
  assert.ok(
    payloadBytes < 256 * 1024,
    `multi-byte payload ${payloadBytes} bytes should be under 256 KB (not ${seenBodyStr.length} chars)`
  );

  // Should have dropped many turns (because byte size is larger than char count)
  assert.ok(seenBody.messages.length < 100, "should have dropped many turns");
});
