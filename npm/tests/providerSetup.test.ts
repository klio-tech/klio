// Tests for the interactive provider-setup orchestrator.
//
// We never touch real stdin or the network here — all four side-effect
// boundaries (`promptFn`, `probeKey`, `probeEmbedding`, `probeChat`,
// and `log`) are injectable, so the orchestrator is exercised purely
// through deterministic stubs.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type OllamaSetupDeps,
  setupOllama,
  setupProvider,
} from "../src/providerSetup.js";
import type { OllamaModel } from "../src/ollama.js";

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

// ---------------------------------------------------------------------------
// setupOllama
// ---------------------------------------------------------------------------
//
// Like the OpenRouter tests, every dep is injected. No real fetch,
// no real spawn. The state machine has three branches we need to
// pin: CLI absent, daemon down, and the green-path success. We also
// cover the consent-driven pull and the abort-on-decline edge.

const EMBED_DIMS: Record<string, number> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "snowflake-arctic-embed2": 1024,
  "bge-m3": 1024,
};

function bare(name: string): string {
  const i = name.indexOf(":");
  return i >= 0 ? name.slice(0, i) : name;
}

function makeOllamaDeps(
  overrides: Partial<OllamaSetupDeps> & {
    inputs?: string[];
  } = {},
): OllamaSetupDeps & { inputs: string[]; cursor: { i: number }; logs: string[] } {
  const inputs = overrides.inputs ?? [];
  const cursor = { i: 0 };
  const logs: string[] = [];
  const deps: OllamaSetupDeps = {
    promptFn: overrides.promptFn ?? (async () => inputs[cursor.i++] ?? ""),
    log: overrides.log ?? ((line: string) => logs.push(line)),
    isRunning: overrides.isRunning ?? (async () => true),
    hasOllamaCli: overrides.hasOllamaCli ?? (async () => true),
    listModels: overrides.listModels ?? (async () => []),
    pullModel: overrides.pullModel ?? (async () => {}),
    getEmbedDim:
      overrides.getEmbedDim ?? ((name: string) => EMBED_DIMS[bare(name)]),
    filterEmbed:
      overrides.filterEmbed ??
      ((models: OllamaModel[]) =>
        models.filter((m) => EMBED_DIMS[bare(m.name)] !== undefined)),
  };
  return Object.assign(deps, { inputs, cursor, logs });
}

test("setupOllama returns fallback when CLI is absent and user consents", async () => {
  const deps = makeOllamaDeps({
    hasOllamaCli: async () => false,
    inputs: ["Y"],
  });
  const result = await setupOllama(deps);
  assert.equal(result.kind, "fallback");
  if (result.kind === "fallback") {
    assert.match(result.reason, /CLI not found/);
  }
});

test("setupOllama throws when CLI absent and user declines fallback", async () => {
  const deps = makeOllamaDeps({
    hasOllamaCli: async () => false,
    inputs: ["n"],
  });
  await assert.rejects(setupOllama(deps), /Cannot continue/);
});

test("setupOllama returns fallback when daemon is down", async () => {
  const deps = makeOllamaDeps({
    hasOllamaCli: async () => true,
    isRunning: async () => false,
    inputs: ["Y"],
  });
  const result = await setupOllama(deps);
  assert.equal(result.kind, "fallback");
  if (result.kind === "fallback") {
    assert.match(result.reason, /daemon is not running/);
  }
});

test("setupOllama returns OllamaConfig when both models already installed", async () => {
  const deps = makeOllamaDeps({
    listModels: async () => [
      { name: "nomic-embed-text:latest", size: 274_000_000 },
      { name: "llama3.1:8b", size: 4_700_000_000 },
    ],
    // Two prompts: embed picker default (1), chat picker default (1).
    inputs: ["1", "1"],
  });
  const result = await setupOllama(deps);
  assert.equal(result.kind, "ollama");
  if (result.kind === "ollama") {
    assert.equal(result.embeddingModel, "nomic-embed-text:latest");
    assert.equal(result.embeddingDim, 768);
    assert.equal(result.extractionModel, "llama3.1:8b");
  }
});

test("setupOllama prompts to pull when no embedding model is installed", async () => {
  const pulls: string[] = [];
  // Simulate the post-pull list having both models.
  let listCalls = 0;
  const deps = makeOllamaDeps({
    listModels: async () => {
      listCalls++;
      if (listCalls === 1) {
        // First listing: only a chat model, no embed.
        return [{ name: "llama3.1:8b", size: 4_700_000_000 }];
      }
      return [
        { name: "nomic-embed-text:latest", size: 274_000_000 },
        { name: "llama3.1:8b", size: 4_700_000_000 },
      ];
    },
    pullModel: async (name: string) => {
      pulls.push(name);
    },
    // Inputs in order: consent to pull (Y), embed pick (1), chat pick (1).
    inputs: ["Y", "1", "1"],
  });
  const result = await setupOllama(deps);
  assert.deepEqual(pulls, ["nomic-embed-text"]);
  assert.equal(result.kind, "ollama");
  if (result.kind === "ollama") {
    assert.equal(result.embeddingModel, "nomic-embed-text:latest");
    assert.equal(result.extractionModel, "llama3.1:8b");
  }
});

test("setupOllama falls back when user declines embed pull", async () => {
  const deps = makeOllamaDeps({
    listModels: async () => [{ name: "llama3.1:8b", size: 4_700_000_000 }],
    inputs: ["n"],
  });
  const result = await setupOllama(deps);
  assert.equal(result.kind, "fallback");
  if (result.kind === "fallback") {
    assert.match(result.reason, /pull declined/);
  }
});

test("setupOllama prompts to pull a chat model when none installed", async () => {
  const pulls: string[] = [];
  let listCalls = 0;
  const deps = makeOllamaDeps({
    listModels: async () => {
      listCalls++;
      if (listCalls === 1) {
        // No models at all.
        return [];
      }
      if (listCalls === 2) {
        // After embed pull.
        return [{ name: "nomic-embed-text:latest", size: 274_000_000 }];
      }
      // After chat pull.
      return [
        { name: "nomic-embed-text:latest", size: 274_000_000 },
        { name: "llama3.1:8b", size: 4_700_000_000 },
      ];
    },
    pullModel: async (name: string) => {
      pulls.push(name);
    },
    // consent embed, embed pick, consent chat, chat pick
    inputs: ["Y", "1", "Y", "1"],
  });
  const result = await setupOllama(deps);
  assert.deepEqual(pulls, ["nomic-embed-text", "llama3.1:8b"]);
  assert.equal(result.kind, "ollama");
});

test("setupOllama falls back when user declines chat pull", async () => {
  let listCalls = 0;
  const deps = makeOllamaDeps({
    listModels: async () => {
      listCalls++;
      if (listCalls === 1) return [];
      // Embed model installed after the pull, but no chat models.
      return [{ name: "nomic-embed-text:latest", size: 274_000_000 }];
    },
    // consent embed (Y), embed pick (1), consent chat (n)
    inputs: ["Y", "1", "n"],
  });
  const result = await setupOllama(deps);
  assert.equal(result.kind, "fallback");
  if (result.kind === "fallback") {
    assert.match(result.reason, /chat model.*pull declined/);
  }
});

test("setupOllama falls back when picked embed model has unknown dim", async () => {
  const deps = makeOllamaDeps({
    listModels: async () => [
      { name: "nomic-embed-text:latest", size: 274_000_000 },
    ],
    // Type a custom name instead of picking; getEmbedDim returns
    // undefined for it.
    inputs: ["mystery-model:v1"],
  });
  const result = await setupOllama(deps);
  assert.equal(result.kind, "fallback");
  if (result.kind === "fallback") {
    assert.match(result.reason, /dim unknown/);
  }
});

test("setupOllama forwards pull progress lines to log", async () => {
  const deps = makeOllamaDeps({
    listModels: async () => [{ name: "llama3.1:8b", size: 4_700_000_000 }],
    pullModel: async (_name, onProgress) => {
      onProgress("pulling manifest");
      onProgress("pulling abc123: 100%");
    },
    inputs: ["Y", "1", "1"],
  });
  await setupOllama(deps);
  const text = deps.logs.join("\n");
  assert.match(text, /pulling manifest/);
  assert.match(text, /pulling abc123: 100%/);
});
