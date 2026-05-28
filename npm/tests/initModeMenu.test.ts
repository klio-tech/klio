import { strict as assert } from "node:assert";
import { test } from "node:test";

import { selectInitMode, type InitMode } from "../src/initModeMenu.js";

test("default picks Cloud (empty input / Enter)", async () => {
  const result = await selectInitMode({
    promptFn: async () => "",
    log: () => {},
  });
  assert.equal(result, "cloud" satisfies InitMode);
});

test("explicit '1' picks Cloud", async () => {
  const result = await selectInitMode({
    promptFn: async () => "1",
    log: () => {},
  });
  assert.equal(result, "cloud");
});

test("'2' picks Local", async () => {
  const result = await selectInitMode({
    promptFn: async () => "2",
    log: () => {},
  });
  assert.equal(result, "local");
});

test("invalid input re-prompts until valid", async () => {
  const inputs = ["banana", "9", "0", "2"];
  let i = 0;
  const errors: string[] = [];
  const result = await selectInitMode({
    promptFn: async () => inputs[i++],
    log: (line) => {
      if (line.includes("✗")) errors.push(line);
    },
  });
  assert.equal(result, "local");
  assert.equal(i, 4);
  assert.equal(errors.length, 3);
});

test("input is trimmed before validation", async () => {
  const result = await selectInitMode({
    promptFn: async () => "  2  ",
    log: () => {},
  });
  assert.equal(result, "local");
});

test("menu mentions both modes and marks Cloud recommended", async () => {
  const lines: string[] = [];
  await selectInitMode({
    promptFn: async () => "",
    log: (line) => lines.push(line),
  });
  const all = lines.join("\n");
  assert.match(all, /Cloud/);
  assert.match(all, /Local/);
  assert.match(all, /recommended/i);
  assert.match(all, /1\)/);
  assert.match(all, /2\)/);
});
