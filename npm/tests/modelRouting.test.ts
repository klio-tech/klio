// Routing-shape tests for the helpers that turn a user-picked model
// name into the prefixed form `KLIO_EMBEDDING_MODEL` /
// `KLIO_EXTRACTION_MODEL` accept.
//
// Why this file exists: 0.4.1 shipped a bug where Ollama-listed
// models (`nomic-embed-text:latest`) were forwarded to the engine
// with the `:tag` suffix intact. The engine's embedding registry
// keys by bare model name and 500'd on every entries / recall call
// during the wow-moment phase of `npx @klio-tech/klio init`. These
// tests pin the npm-side normalization so the fix can't silently
// regress.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  bareOllamaModel,
  prefixModel,
  prefixEmbeddingModel,
} from "../src/modelRouting.js";

test("bareOllamaModel strips :tag from a bare name", () => {
  assert.equal(bareOllamaModel("nomic-embed-text:latest"), "nomic-embed-text");
  assert.equal(bareOllamaModel("mxbai-embed-large:v1.5"), "mxbai-embed-large");
  assert.equal(bareOllamaModel("qwen2.5:7b-instruct"), "qwen2.5");
});

test("bareOllamaModel strips :tag from a prefixed name", () => {
  // Already-prefixed inputs are tolerated — strip operates on the last
  // path segment only, so the prefix is preserved.
  assert.equal(
    bareOllamaModel("ollama/nomic-embed-text:latest"),
    "ollama/nomic-embed-text",
  );
  assert.equal(
    bareOllamaModel("ollama/mxbai-embed-large:q4_K_M"),
    "ollama/mxbai-embed-large",
  );
});

test("bareOllamaModel is a no-op when there is no tag", () => {
  assert.equal(bareOllamaModel("nomic-embed-text"), "nomic-embed-text");
  assert.equal(
    bareOllamaModel("ollama/nomic-embed-text"),
    "ollama/nomic-embed-text",
  );
});

test("bareOllamaModel preserves multi-segment slashed paths", () => {
  // OpenRouter ids carry slashes but never colons — must pass
  // through verbatim.
  assert.equal(
    bareOllamaModel("openrouter/openai/text-embedding-3-small"),
    "openrouter/openai/text-embedding-3-small",
  );
});

test("prefixModel adds the kind prefix when missing", () => {
  assert.equal(
    prefixModel("ollama", "nomic-embed-text"),
    "ollama/nomic-embed-text",
  );
  assert.equal(
    prefixModel("openrouter", "openai/text-embedding-3-small"),
    "openrouter/openai/text-embedding-3-small",
  );
  assert.equal(
    prefixModel("custom", "llama-3.1-70b"),
    "custom/llama-3.1-70b",
  );
});

test("prefixModel is idempotent for already-prefixed names", () => {
  assert.equal(
    prefixModel("ollama", "ollama/nomic-embed-text"),
    "ollama/nomic-embed-text",
  );
});

test("prefixModel forwards undefined unchanged", () => {
  assert.equal(prefixModel("ollama", undefined), undefined);
});

test("prefixModel does NOT strip Ollama tags (chat tags are meaningful)", () => {
  // The chat / extraction slot must keep `qwen2.5:7b-instruct` etc. —
  // chat dispatch in the engine does not validate against a registry
  // and the tag is part of the Ollama model identity (different tag
  // = different weights). Stripping the tag here would silently
  // re-route to a different model.
  assert.equal(
    prefixModel("ollama", "qwen2.5:7b-instruct"),
    "ollama/qwen2.5:7b-instruct",
  );
});

test("prefixEmbeddingModel STRIPS Ollama tags (the 0.4.1 production bug)", () => {
  // The embedding registry keys by bare name. Ollama-tagged inputs
  // arrived from the picker as `nomic-embed-text:latest` and 500'd
  // every Phase 5 recall. The fix: strip the tag at the routing
  // boundary so the engine sees only the bare form.
  assert.equal(
    prefixEmbeddingModel("ollama", "nomic-embed-text:latest"),
    "ollama/nomic-embed-text",
  );
  assert.equal(
    prefixEmbeddingModel("ollama", "mxbai-embed-large:v1.5"),
    "ollama/mxbai-embed-large",
  );
});

test("prefixEmbeddingModel is idempotent on already-clean Ollama names", () => {
  assert.equal(
    prefixEmbeddingModel("ollama", "nomic-embed-text"),
    "ollama/nomic-embed-text",
  );
  assert.equal(
    prefixEmbeddingModel("ollama", "ollama/nomic-embed-text"),
    "ollama/nomic-embed-text",
  );
});

test("prefixEmbeddingModel cleans tags even when input is already prefixed", () => {
  // Re-running init against an existing `~/.klio/.env` that holds
  // the buggy 0.4.1 value (`ollama/nomic-embed-text:latest`) must
  // recover by re-cleaning the value, not preserve the bug.
  assert.equal(
    prefixEmbeddingModel("ollama", "ollama/nomic-embed-text:latest"),
    "ollama/nomic-embed-text",
  );
});

test("prefixEmbeddingModel passes openrouter ids through unchanged", () => {
  // OpenRouter ids carry slashes but never colons; tag stripping
  // is a no-op. The tested form mirrors what the openrouter picker
  // emits.
  assert.equal(
    prefixEmbeddingModel("openrouter", "openai/text-embedding-3-small"),
    "openrouter/openai/text-embedding-3-small",
  );
});

test("prefixEmbeddingModel passes custom ids through unchanged", () => {
  // custom/* names are bypass-the-registry intentionally; they may
  // legitimately carry colons (e.g. a self-hosted Ollama-compat
  // proxy that mirrors Ollama tags). Keep the tag so dispatch
  // works.
  assert.equal(
    prefixEmbeddingModel("custom", "my-embed:v1"),
    "custom/my-embed:v1",
  );
});

test("prefixEmbeddingModel forwards undefined unchanged", () => {
  assert.equal(prefixEmbeddingModel("ollama", undefined), undefined);
});
