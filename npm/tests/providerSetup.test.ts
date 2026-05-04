// Tests for the interactive provider-setup orchestrator.
//
// We never touch real stdin or the network here — all four side-effect
// boundaries (`promptFn`, `probeKey`, `probeEmbedding`, `probeChat`,
// and `log`) are injectable, so the orchestrator is exercised purely
// through deterministic stubs.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type CustomSetupDeps,
  type OllamaSetupDeps,
  setupCustom,
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

// ---------------------------------------------------------------------------
// setupCustom
// ---------------------------------------------------------------------------
//
// Same dependency-injection seam as `setupProvider` and `setupOllama`.
// All three probe boundaries are stubbed; tests assert the
// orchestrator's control flow (re-prompts, picker shape, fallback)
// rather than the wire shape, which is covered in
// `customEndpoint.test.ts`.

function makeCustomDeps(
  overrides: Partial<CustomSetupDeps> & { inputs?: string[] } = {},
): CustomSetupDeps & {
  inputs: string[];
  cursor: { i: number };
  logs: string[];
} {
  const inputs = overrides.inputs ?? [];
  const cursor = { i: 0 };
  const logs: string[] = [];
  const deps: CustomSetupDeps = {
    promptFn: overrides.promptFn ?? (async () => inputs[cursor.i++] ?? ""),
    log: overrides.log ?? ((line: string) => logs.push(line)),
    probeEndpoint:
      overrides.probeEndpoint ??
      (async () => ({ modelsAvailable: 0, modelsList: [] })),
    probeEmbed:
      overrides.probeEmbed ??
      (async () => ({ dim: 1536, tokensUsed: 1 })),
    probeChat:
      overrides.probeChat ??
      (async () => ({ tokensUsed: 1, latencyMs: 50 })),
  };
  return Object.assign(deps, { inputs, cursor, logs });
}

test("setupCustom returns CustomConfig when all probes pass", async () => {
  const deps = makeCustomDeps({
    // base URL, API key, embed pick (1 → text-embedding-3-small),
    // chat pick (2 → claude-3-5-haiku).
    inputs: [
      "https://litellm.acme.corp/v1",
      "sk-test",
      "1",
      "2",
    ],
    probeEndpoint: async () => ({
      modelsAvailable: 2,
      modelsList: ["text-embedding-3-small", "claude-3-5-haiku"],
    }),
    probeEmbed: async () => ({ dim: 1536, tokensUsed: 1 }),
    probeChat: async () => ({ tokensUsed: 4, latencyMs: 120 }),
  });
  const cfg = await setupCustom(deps);
  assert.equal(cfg.kind, "custom");
  assert.equal(cfg.baseUrl, "https://litellm.acme.corp/v1");
  assert.equal(cfg.apiKey, "sk-test");
  assert.equal(cfg.embeddingModel, "text-embedding-3-small");
  assert.equal(cfg.embeddingDim, 1536);
  assert.equal(cfg.extractionModel, "claude-3-5-haiku");
});

test("setupCustom re-prompts on endpoint probe failure", async () => {
  let endpointCalls = 0;
  const deps = makeCustomDeps({
    // bad URL+key → retry → good URL+key, then embed pick, chat pick
    inputs: [
      "https://bad/v1",
      "bad",
      "https://good/v1",
      "sk-good",
      "1",
      "1",
    ],
    probeEndpoint: async (url) => {
      endpointCalls++;
      if (url === "https://bad/v1") throw new Error("Invalid key");
      return { modelsAvailable: 1, modelsList: ["model-a"] };
    },
  });
  const cfg = await setupCustom(deps);
  assert.equal(endpointCalls, 2);
  assert.equal(cfg.baseUrl, "https://good/v1");
  assert.equal(cfg.apiKey, "sk-good");
  // Failure log line appears.
  const text = deps.logs.join("\n");
  assert.match(text, /Invalid key/);
});

test("setupCustom re-prompts on embedding probe failure", async () => {
  let embedCalls = 0;
  const deps = makeCustomDeps({
    // base URL, API key, bad embed pick (custom name), good embed pick (1), chat pick (1)
    inputs: [
      "https://x/v1",
      "sk",
      "broken-embed",
      "1",
      "1",
    ],
    probeEndpoint: async () => ({
      modelsAvailable: 1,
      modelsList: ["good-embed"],
    }),
    probeEmbed: async (_url, _key, model) => {
      embedCalls++;
      if (model === "broken-embed") throw new Error("Model not found");
      return { dim: 768, tokensUsed: 2 };
    },
  });
  const cfg = await setupCustom(deps);
  assert.equal(embedCalls, 2);
  assert.equal(cfg.embeddingModel, "good-embed");
  assert.equal(cfg.embeddingDim, 768);
});

test("setupCustom re-prompts on chat probe failure", async () => {
  let chatCalls = 0;
  const deps = makeCustomDeps({
    // base URL, API key, embed pick (1), bad chat (custom name), good chat pick (1)
    inputs: [
      "https://x/v1",
      "sk",
      "1",
      "broken-chat",
      "1",
    ],
    probeEndpoint: async () => ({
      modelsAvailable: 1,
      modelsList: ["good-model"],
    }),
    probeChat: async (_url, _key, model) => {
      chatCalls++;
      if (model === "broken-chat") throw new Error("rate limited");
      return { tokensUsed: 5, latencyMs: 80 };
    },
  });
  const cfg = await setupCustom(deps);
  assert.equal(chatCalls, 2);
  assert.equal(cfg.extractionModel, "good-model");
});

test("setupCustom falls back to free-form when modelsList is null (404 case)", async () => {
  const seen: Array<{ message: string; default?: string }> = [];
  const deps = makeCustomDeps({
    // base URL, API key, embed name (free-form), chat name (free-form)
    inputs: [
      "https://localproxy/v1",
      "",
      "my-custom-embed",
      "my-custom-chat",
    ],
    promptFn: async (opts) => {
      seen.push({ message: opts.message, default: opts.default });
      const inputs = [
        "https://localproxy/v1",
        "",
        "my-custom-embed",
        "my-custom-chat",
      ];
      return inputs[seen.length - 1] ?? "";
    },
    probeEndpoint: async () => ({
      modelsAvailable: 0,
      modelsList: null,
    }),
  });
  const cfg = await setupCustom(deps);
  assert.equal(cfg.embeddingModel, "my-custom-embed");
  assert.equal(cfg.extractionModel, "my-custom-chat");
  // The model prompts should NOT carry the picker default of "1" —
  // they're free-form because modelsList is null.
  const embedPrompt = seen.find((s) => s.message === "Embedding model");
  const chatPrompt = seen.find((s) => s.message === "Extraction model");
  assert.ok(embedPrompt);
  assert.equal(embedPrompt?.default, undefined);
  assert.ok(chatPrompt);
  assert.equal(chatPrompt?.default, undefined);
});

test("setupCustom falls back to free-form when modelsList is empty", async () => {
  const deps = makeCustomDeps({
    inputs: [
      "https://x/v1",
      "sk",
      "embed-x",
      "chat-x",
    ],
    probeEndpoint: async () => ({
      modelsAvailable: 0,
      modelsList: [],
    }),
  });
  const cfg = await setupCustom(deps);
  assert.equal(cfg.embeddingModel, "embed-x");
  assert.equal(cfg.extractionModel, "chat-x");
});

test("setupCustom accepts empty API key (local proxy without auth)", async () => {
  const seenKeys: string[] = [];
  const deps = makeCustomDeps({
    inputs: [
      "http://localhost:4000/v1",
      "",
      "embed",
      "chat",
    ],
    probeEndpoint: async (_url, key) => {
      seenKeys.push(key ?? "<undef>");
      return { modelsAvailable: 0, modelsList: null };
    },
    probeEmbed: async (_url, key) => {
      seenKeys.push(key ?? "<undef>");
      return { dim: 768, tokensUsed: 1 };
    },
    probeChat: async (_url, key) => {
      seenKeys.push(key ?? "<undef>");
      return { tokensUsed: 1, latencyMs: 50 };
    },
  });
  const cfg = await setupCustom(deps);
  assert.equal(cfg.apiKey, "");
  // Every probe call saw the empty string.
  assert.deepEqual(seenKeys, ["", "", ""]);
});

test("setupCustom strips trailing slash from base URL", async () => {
  let seenUrl = "";
  const deps = makeCustomDeps({
    inputs: [
      "https://x/v1/",
      "sk",
      "embed",
      "chat",
    ],
    probeEndpoint: async (url) => {
      seenUrl = url;
      return { modelsAvailable: 0, modelsList: null };
    },
  });
  const cfg = await setupCustom(deps);
  assert.equal(cfg.baseUrl, "https://x/v1");
  assert.equal(seenUrl, "https://x/v1");
});

test("setupCustom picker accepts numeric choice over modelsList", async () => {
  const deps = makeCustomDeps({
    // base URL, API key, embed pick "2", chat pick "3"
    inputs: [
      "https://x/v1",
      "sk",
      "2",
      "3",
    ],
    probeEndpoint: async () => ({
      modelsAvailable: 4,
      modelsList: ["a-model", "b-model", "c-model", "d-model"],
    }),
  });
  const cfg = await setupCustom(deps);
  assert.equal(cfg.embeddingModel, "b-model");
  assert.equal(cfg.extractionModel, "c-model");
});

test("setupCustom picker accepts custom typed name as escape hatch", async () => {
  const deps = makeCustomDeps({
    inputs: [
      "https://x/v1",
      "sk",
      "my-special-embed",
      "my-special-chat",
    ],
    probeEndpoint: async () => ({
      modelsAvailable: 2,
      modelsList: ["a-model", "b-model"],
    }),
  });
  const cfg = await setupCustom(deps);
  assert.equal(cfg.embeddingModel, "my-special-embed");
  assert.equal(cfg.extractionModel, "my-special-chat");
});

test("setupCustom picker shows at most 5 models", async () => {
  const deps = makeCustomDeps({
    inputs: [
      "https://x/v1",
      "sk",
      "1",
      "1",
    ],
    probeEndpoint: async () => ({
      modelsAvailable: 10,
      modelsList: [
        "m1",
        "m2",
        "m3",
        "m4",
        "m5",
        "m6",
        "m7",
        "m8",
        "m9",
        "m10",
      ],
    }),
  });
  await setupCustom(deps);
  // The picker should have rendered at most 5 numbered lines per
  // pick step. Count "  N) " entries across both pickers.
  const numbered = deps.logs.filter((l) => /^\s+\d+\)\s/.test(l));
  // 5 for embed picker + 5 for chat picker = 10 total.
  assert.equal(numbered.length, 10);
});

test("setupCustom picker default of empty input → first option", async () => {
  const deps = makeCustomDeps({
    inputs: [
      "https://x/v1",
      "sk",
      "", // empty → default to first option
      "", // empty → default to first option
    ],
    probeEndpoint: async () => ({
      modelsAvailable: 2,
      modelsList: ["first-model", "second-model"],
    }),
  });
  const cfg = await setupCustom(deps);
  assert.equal(cfg.embeddingModel, "first-model");
  assert.equal(cfg.extractionModel, "first-model");
});
