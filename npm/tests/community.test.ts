import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runCommunityAsks } from "../src/community.js";

const REPO_URL = "https://github.com/klio-tech/klio";
const DISCORD_URL = "https://discord.gg/xRRPnW3fN2";

test("runCommunityAsks opens both URLs when user accepts both", async () => {
  const opened: string[] = [];
  await runCommunityAsks({
    // Empty answer simulates pressing Enter on the default-Y prompt.
    promptFn: async ({ default: d }) => d ?? "",
    openUrlFn: (u) => opened.push(u),
    log: () => {},
  });

  assert.deepEqual(opened, [REPO_URL, DISCORD_URL]);
});

test("runCommunityAsks skips both when user declines both", async () => {
  const opened: string[] = [];
  await runCommunityAsks({
    promptFn: async () => "n",
    openUrlFn: (u) => opened.push(u),
    log: () => {},
  });

  assert.equal(opened.length, 0);
});

test("runCommunityAsks treats explicit 'y' / 'yes' / 'Y' as accept", async () => {
  const answers = ["y", "Y", "yes", "YES", "  y  "];
  for (const answer of answers) {
    const opened: string[] = [];
    await runCommunityAsks({
      promptFn: async () => answer,
      openUrlFn: (u) => opened.push(u),
      log: () => {},
    });
    assert.deepEqual(
      opened,
      [REPO_URL, DISCORD_URL],
      `expected accept for ${JSON.stringify(answer)}`,
    );
  }
});

test("runCommunityAsks accepts only the star, declines Discord", async () => {
  const opened: string[] = [];
  let i = 0;
  await runCommunityAsks({
    promptFn: async () => {
      const answers = ["", "n"];
      return answers[i++] ?? "n";
    },
    openUrlFn: (u) => opened.push(u),
    log: () => {},
  });

  assert.deepEqual(opened, [REPO_URL]);
});

test("runCommunityAsks passes 'Y' as the default for both prompts", async () => {
  const observedDefaults: (string | undefined)[] = [];
  await runCommunityAsks({
    promptFn: async (opts) => {
      observedDefaults.push(opts.default);
      return "n";
    },
    openUrlFn: () => {},
    log: () => {},
  });

  assert.deepEqual(observedDefaults, ["Y", "Y"]);
});
