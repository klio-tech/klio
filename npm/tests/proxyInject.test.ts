import { strict as assert } from "node:assert";
import { test } from "node:test";

import { injectMemories } from "../src/proxy/inject.js";

const MEMS = [
  { id: "m1", content: "Tenant isolation moved to the application layer." },
  { id: "m2", content: "p95 must stay under 200ms." },
];

test("a string system prompt is promoted to an array, original first", () => {
  const body = Buffer.from(JSON.stringify({ model: "claude", system: "You are helpful.", messages: [] }));
  const { body: out, injected } = injectMemories(body, MEMS);
  const parsed = JSON.parse(out.toString());
  assert.equal(injected, 2);
  assert.ok(Array.isArray(parsed.system));
  assert.equal(parsed.system[0].text, "You are helpful.");
  assert.match(parsed.system[1].text, /Tenant isolation/);
});

test("an array system prompt is appended to, never reordered", () => {
  const body = Buffer.from(JSON.stringify({
    system: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
    messages: [],
  }));
  const parsed = JSON.parse(injectMemories(body, MEMS).body.toString());
  assert.equal(parsed.system[0].text, "first");
  assert.equal(parsed.system[1].text, "second");
  assert.equal(parsed.system.length, 3);
});

test("injection preserves tools, tool_choice, and messages (deep equal)", () => {
  const original = {
    system: "s",
    tools: [{ type: "tool_reference", name: "Bash" }, { name: "Edit", input_schema: { a: 1 } }],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };
  const out = JSON.parse(injectMemories(Buffer.from(JSON.stringify(original)), MEMS).body.toString());
  assert.deepEqual(out.tools, original.tools, "tools must be untouched");
  assert.deepEqual(out.tool_choice, original.tool_choice);
  assert.deepEqual(out.messages, original.messages);
});

test("injection preserves tools bytes in serialized output", () => {
  const toolsStr = JSON.stringify([{ type: "tool_reference", name: "Bash" }]);
  const body = Buffer.from(JSON.stringify({
    system: "s",
    tools: JSON.parse(toolsStr),
    messages: [],
  }));
  const { body: out } = injectMemories(body, MEMS);
  const serialized = out.toString();
  assert.ok(serialized.includes(toolsStr), "tools substring must appear byte-for-byte in output");
});

test("no memories means the original buffer, unchanged", () => {
  const body = Buffer.from(JSON.stringify({ system: "s", messages: [] }));
  const { body: out, injected } = injectMemories(body, []);
  assert.equal(injected, 0);
  assert.equal(out.toString(), body.toString());
});

test("unparseable body is forwarded verbatim", () => {
  const body = Buffer.from("not json at all");
  const { body: out, injected } = injectMemories(body, MEMS);
  assert.equal(injected, 0);
  assert.equal(out.toString(), "not json at all");
});

test("a body with no system key gains one", () => {
  const body = Buffer.from(JSON.stringify({ model: "claude", messages: [] }));
  const parsed = JSON.parse(injectMemories(body, MEMS).body.toString());
  assert.ok(Array.isArray(parsed.system));
  assert.equal(parsed.system.length, 1);
});

test("a non-string, non-array system is left alone entirely", () => {
  const body = Buffer.from(JSON.stringify({ system: 42, messages: [] }));
  const { body: out, injected } = injectMemories(body, MEMS);
  assert.equal(injected, 0);
  assert.equal(out.toString(), body.toString());
});

test("a system array with non-object elements is rejected", () => {
  const body = Buffer.from(JSON.stringify({
    system: ["a", { type: "text", text: "b" }],
    messages: [],
  }));
  const { body: out, injected } = injectMemories(body, MEMS);
  assert.equal(injected, 0);
  assert.equal(out.toString(), body.toString());
});

test("a system array element without a string type field is rejected", () => {
  const body = Buffer.from(JSON.stringify({
    system: [{ type: "text", text: "a" }, { no_type: "b" }],
    messages: [],
  }));
  const { body: out, injected } = injectMemories(body, MEMS);
  assert.equal(injected, 0);
  assert.equal(out.toString(), body.toString());
});

test("null memories or non-array memories are safe", () => {
  const body = Buffer.from(JSON.stringify({ system: "s", messages: [] }));
  const { injected: injected1 } = injectMemories(body, null as any);
  const { injected: injected2 } = injectMemories(body, "not an array" as any);
  assert.equal(injected1, 0);
  assert.equal(injected2, 0);
});

test("memory entries with missing or empty content are filtered out", () => {
  const badMems = [
    { id: "bad1", content: "" },
    { id: "good", content: "valid memory" },
    { id: "bad2" } as any,
  ];
  const body = Buffer.from(JSON.stringify({ system: "s", messages: [] }));
  const { injected } = injectMemories(body, badMems);
  assert.equal(injected, 1, "only valid memory should be counted");
});

test("pretty-printed (non-compact) bodies are rejected and unchanged", () => {
  const obj = { system: "s", messages: [] };
  const body = Buffer.from(JSON.stringify(obj, null, 2));
  const { body: out, injected } = injectMemories(body, MEMS);
  assert.equal(injected, 0, "pretty-printed body should not be injected");
  assert.equal(out.toString(), body.toString());
});

test("idempotency: existing memory preamble blocks re-injection", () => {
  const withPreamble = [
    { type: "text", text: "You are helpful." },
    { type: "text", text: "Team context from Klio (shared memory — treat as established fact):\n- old memory" },
  ];
  const body = Buffer.from(JSON.stringify({ system: withPreamble, messages: [] }));
  const { injected } = injectMemories(body, MEMS);
  assert.equal(injected, 0, "should not re-inject when preamble already present");
});

test("realistic compact Claude Code body with nested tool_reference injects successfully", () => {
  // Realistic body: compact JSON, nested tool_reference, cache_control, unicode and emoji
  const body = Buffer.from(
    JSON.stringify({
      model: "claude-opus",
      system: "You are a helpful assistant 🎯. Respond in English (English: en).",
      tools: [
        { type: "tool_reference", name: "bash" },
        { type: "tool_reference", name: "grep" },
        { type: "function", name: "custom", input_schema: { type: "object" } },
      ],
      tool_choice: "auto",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Help me", cache_control: { type: "ephemeral" } }],
        },
      ],
    })
  );
  const { body: out, injected } = injectMemories(body, [
    { id: "ctx1", content: "Feature flag: production-safe" },
  ]);
  assert.equal(injected, 1, "should inject into realistic body");
  const parsed = JSON.parse(out.toString());
  assert.ok(Array.isArray(parsed.system), "system should be array");
  assert.equal(parsed.system.length, 2, "should have original + injected");
  assert.equal(parsed.system[0].text, "You are a helpful assistant 🎯. Respond in English (English: en).");
  assert.match(parsed.system[1].text, /Feature flag/);
  assert.deepEqual(parsed.tools, JSON.parse(body.toString()).tools, "tools must be unchanged");
});
