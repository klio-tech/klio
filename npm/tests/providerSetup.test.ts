// Tests for the interactive provider-setup orchestrator.
//
// We never touch real stdin or the network here — all four side-effect
// boundaries (`promptFn`, `probeKey`, `probeEmbedding`, `probeChat`,
// and `log`) are injectable, so the orchestrator is exercised purely
// through deterministic stubs.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { setupProvider } from "../src/providerSetup.js";

test("setupProvider returns key + models when all probes pass", async () => {
  const inputs = [
    "sk-or-test",
    "openai/text-embedding-3-small",
    "anthropic/claude-3-5-haiku",
  ];
  let i = 0;
  const cfg = await setupProvider({
    promptFn: async () => inputs[i++],
    probeKey: async () => ({ label: "test", creditRemaining: 42 }),
    probeEmbedding: async () => ({ dim: 1536, tokensUsed: 1 }),
    probeChat: async () => ({ tokensUsed: 1, latencyMs: 200 }),
    fetchCatalog: async () => [],
    log: () => {},
  });
  assert.equal(cfg.openrouterKey, "sk-or-test");
  assert.equal(cfg.embeddingModel, "openai/text-embedding-3-small");
  assert.equal(cfg.extractionModel, "anthropic/claude-3-5-haiku");
  assert.equal(cfg.embeddingDim, 1536);
  assert.equal(cfg.totalTestTokens, 2);
});

test("setupProvider re-prompts on key probe failure", async () => {
  const inputs = [
    "bad",
    "sk-or-good",
    "openai/text-embedding-3-small",
    "anthropic/claude-3-5-haiku",
  ];
  let i = 0;
  let probeCalls = 0;
  await setupProvider({
    promptFn: async () => inputs[i++],
    probeKey: async (k) => {
      probeCalls++;
      if (k === "bad") throw new Error("Invalid key");
      return { label: "ok", creditRemaining: 1 };
    },
    probeEmbedding: async () => ({ dim: 1536, tokensUsed: 1 }),
    probeChat: async () => ({ tokensUsed: 1, latencyMs: 200 }),
    fetchCatalog: async () => [],
    log: () => {},
  });
  assert.equal(probeCalls, 2);
});

test("setupProvider re-prompts on embedding probe failure", async () => {
  const inputs = [
    "sk-or-good",
    "bad/embed",
    "openai/text-embedding-3-small",
    "anthropic/claude-3-5-haiku",
  ];
  let i = 0;
  let embedCalls = 0;
  const cfg = await setupProvider({
    promptFn: async () => inputs[i++],
    probeKey: async () => ({ label: "ok", creditRemaining: null }),
    probeEmbedding: async (_k, m) => {
      embedCalls++;
      if (m === "bad/embed") throw new Error("Model not found");
      return { dim: 1536, tokensUsed: 1 };
    },
    probeChat: async () => ({ tokensUsed: 1, latencyMs: 200 }),
    fetchCatalog: async () => [],
    log: () => {},
  });
  assert.equal(embedCalls, 2);
  assert.equal(cfg.embeddingModel, "openai/text-embedding-3-small");
});

test("setupProvider re-prompts on chat probe failure", async () => {
  const inputs = [
    "sk-or-good",
    "openai/text-embedding-3-small",
    "bad/chat",
    "anthropic/claude-3-5-haiku",
  ];
  let i = 0;
  let chatCalls = 0;
  const cfg = await setupProvider({
    promptFn: async () => inputs[i++],
    probeKey: async () => ({ label: "ok", creditRemaining: null }),
    probeEmbedding: async () => ({ dim: 768, tokensUsed: 3 }),
    probeChat: async (_k, m) => {
      chatCalls++;
      if (m === "bad/chat") throw new Error("Model not found");
      return { tokensUsed: 5, latencyMs: 100 };
    },
    fetchCatalog: async () => [],
    log: () => {},
  });
  assert.equal(chatCalls, 2);
  assert.equal(cfg.extractionModel, "anthropic/claude-3-5-haiku");
  assert.equal(cfg.totalTestTokens, 8);
});

test("setupProvider passes embedding/chat defaults to promptFn (free-form fallback)", async () => {
  const seen: Array<{ message: string; default?: string; mask?: boolean }> = [];
  await setupProvider({
    promptFn: async (opts) => {
      seen.push({
        message: opts.message,
        default: opts.default,
        mask: opts.mask,
      });
      if (opts.message.includes("API key")) return "sk-or-x";
      return opts.default ?? "";
    },
    probeKey: async () => ({ label: "ok", creditRemaining: null }),
    probeEmbedding: async () => ({ dim: 1536, tokensUsed: 1 }),
    probeChat: async () => ({ tokensUsed: 1, latencyMs: 50 }),
    // Empty catalog → picker degrades to the historical free-form
    // prompt with the historical default. This test pins that
    // contract so we don't accidentally drop it during refactors.
    fetchCatalog: async () => [],
    log: () => {},
  });
  // Three prompts in this exact order: key, embedding, chat.
  assert.equal(seen.length, 3);
  assert.equal(seen[0].mask, true);
  assert.equal(seen[1].default, "openai/text-embedding-3-small");
  assert.equal(seen[2].default, "anthropic/claude-3-5-haiku");
});

test("setupProvider logs the failure message before re-prompting", async () => {
  const inputs = ["bad", "sk-or-good", "openai/text-embedding-3-small", "anthropic/claude-3-5-haiku"];
  let i = 0;
  const logs: string[] = [];
  await setupProvider({
    promptFn: async () => inputs[i++],
    probeKey: async (k) => {
      if (k === "bad") throw new Error("Invalid key");
      return { label: "ok", creditRemaining: null };
    },
    probeEmbedding: async () => ({ dim: 1536, tokensUsed: 1 }),
    probeChat: async () => ({ tokensUsed: 1, latencyMs: 50 }),
    fetchCatalog: async () => [],
    log: (l) => logs.push(l),
  });
  // The first key attempt should have produced a failure log line.
  const failureLine = logs.find((l) => l.includes("Invalid key"));
  assert.ok(failureLine, "expected an Invalid-key failure log line");
});

test("setupProvider uses curated lists from the catalog", async () => {
  const inputs = ["sk-or-test", "1", "1"];
  let i = 0;
  const cfg = await setupProvider({
    promptFn: async () => inputs[i++],
    probeKey: async () => ({ label: "test", creditRemaining: 1 }),
    probeEmbedding: async () => ({ dim: 1536, tokensUsed: 1 }),
    probeChat: async () => ({ tokensUsed: 1, latencyMs: 200 }),
    fetchCatalog: async () => [
      {
        id: "openai/text-embedding-3-small",
        architecture: { modality: "text->embedding" },
        pricing: { prompt: "0.00000002" },
      },
      {
        id: "anthropic/claude-3-5-haiku",
        architecture: { modality: "text->text" },
        supported_parameters: ["tools"],
        pricing: { prompt: "0.0000008", completion: "0.000004" },
      },
    ],
    log: () => {},
  });
  assert.equal(cfg.embeddingModel, "openai/text-embedding-3-small");
  assert.equal(cfg.extractionModel, "anthropic/claude-3-5-haiku");
});

test("setupProvider accepts custom typed model name via escape hatch", async () => {
  const inputs = [
    "sk-or-test",
    "openai/text-embedding-3-small",
    "anthropic/claude-3-5-haiku",
  ];
  let i = 0;
  const cfg = await setupProvider({
    promptFn: async () => inputs[i++],
    probeKey: async () => ({ label: "test", creditRemaining: 1 }),
    probeEmbedding: async () => ({ dim: 1536, tokensUsed: 1 }),
    probeChat: async () => ({ tokensUsed: 1, latencyMs: 200 }),
    fetchCatalog: async () => [],
    log: () => {},
  });
  assert.equal(cfg.embeddingModel, "openai/text-embedding-3-small");
  assert.equal(cfg.extractionModel, "anthropic/claude-3-5-haiku");
});

test("setupProvider falls back to free-form when catalog fetch fails", async () => {
  const inputs = ["sk-or-test", "", ""];
  let i = 0;
  const cfg = await setupProvider({
    promptFn: async () => inputs[i++],
    probeKey: async () => ({ label: "test", creditRemaining: 1 }),
    probeEmbedding: async () => ({ dim: 1536, tokensUsed: 1 }),
    probeChat: async () => ({ tokensUsed: 1, latencyMs: 200 }),
    fetchCatalog: async () => {
      throw new Error("network down");
    },
    log: () => {},
  });
  assert.equal(cfg.embeddingModel, "openai/text-embedding-3-small");
  assert.equal(cfg.extractionModel, "anthropic/claude-3-5-haiku");
});
