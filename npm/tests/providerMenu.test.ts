import { strict as assert } from "node:assert";
import { test } from "node:test";
import { selectProvider, type ProviderKind } from "../src/providerMenu.js";

test("default picks OpenRouter (empty input)", async () => {
  const result = await selectProvider({
    promptFn: async () => "",
    log: () => {},
  });
  assert.equal(result, "openrouter" satisfies ProviderKind);
});

test("explicit '1' picks OpenRouter", async () => {
  const result = await selectProvider({
    promptFn: async () => "1",
    log: () => {},
  });
  assert.equal(result, "openrouter");
});

test("'2' picks Ollama", async () => {
  const result = await selectProvider({
    promptFn: async () => "2",
    log: () => {},
  });
  assert.equal(result, "ollama");
});

test("'3' picks Custom", async () => {
  const result = await selectProvider({
    promptFn: async () => "3",
    log: () => {},
  });
  assert.equal(result, "custom");
});

test("invalid input re-prompts until valid", async () => {
  const inputs = ["banana", "999", "0", "1"];
  let i = 0;
  const errors: string[] = [];
  const result = await selectProvider({
    promptFn: async () => inputs[i++],
    log: (line) => {
      if (line.includes("✗")) errors.push(line);
    },
  });
  assert.equal(result, "openrouter");
  assert.equal(i, 4);
  assert.equal(errors.length, 3); // three rejected attempts before "1"
});

test("input is trimmed before validation", async () => {
  const result = await selectProvider({
    promptFn: async () => "  2  ",
    log: () => {},
  });
  assert.equal(result, "ollama");
});

test("menu is rendered before prompt", async () => {
  const log: string[] = [];
  await selectProvider({
    promptFn: async () => "",
    log: (line) => log.push(line),
  });
  // Menu should mention all three providers
  const all = log.join("\n");
  assert.match(all, /OpenRouter/);
  assert.match(all, /Ollama/);
  assert.match(all, /Custom/);
  assert.match(all, /1\)/);
  assert.match(all, /2\)/);
  assert.match(all, /3\)/);
});
