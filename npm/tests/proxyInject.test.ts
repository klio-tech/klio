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

test("tools and messages are byte-identical after injection", () => {
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
