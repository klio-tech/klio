import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderComposeBody } from "../src/compose.js";

test("compose body includes KLIO_OPENROUTER_API_KEY env var", () => {
  const body = renderComposeBody({
    imageTag: "0.2.0",
    jwtSigningKey: "k",
    embeddingModel: "openrouter/openai/text-embedding-3-small",
    extractionModel: "openrouter/anthropic/claude-3-5-haiku",
  });
  assert.match(body, /KLIO_OPENROUTER_API_KEY/);
  assert.match(body, /KLIO_OPENROUTER_API_KEY: \$\{KLIO_OPENROUTER_API_KEY\}/);
  assert.match(body, /openrouter\/openai\/text-embedding-3-small/);
  assert.match(body, /openrouter\/anthropic\/claude-3-5-haiku/);
});

test("compose body still references the right image tag", () => {
  const body = renderComposeBody({
    imageTag: "0.2.0",
    jwtSigningKey: "k",
    embeddingModel: "openrouter/openai/text-embedding-3-small",
    extractionModel: "openrouter/anthropic/claude-3-5-haiku",
  });
  assert.match(body, /klio-engine:0\.2\.0/);
  assert.match(body, /klio-bridge:0\.2\.0/);
  assert.match(body, /klio-trust-app:0\.2\.0/);
});

test("compose body declares KLIO_EXTRACTION_MODEL on the engine service", () => {
  const body = renderComposeBody({
    imageTag: "0.2.0",
    jwtSigningKey: "k",
    embeddingModel: "openrouter/openai/text-embedding-3-small",
    extractionModel: "openrouter/anthropic/claude-3-5-haiku",
  });
  assert.match(
    body,
    /KLIO_EXTRACTION_MODEL: openrouter\/anthropic\/claude-3-5-haiku/,
  );
  assert.match(
    body,
    /KLIO_EMBEDDING_MODEL: openrouter\/openai\/text-embedding-3-small/,
  );
});

test("compose body interpolates KLIO_OPENROUTER_API_KEY from env file", () => {
  const body = renderComposeBody({
    imageTag: "0.2.0",
    jwtSigningKey: "k",
    embeddingModel: "openrouter/openai/text-embedding-3-small",
    extractionModel: "openrouter/anthropic/claude-3-5-haiku",
  });
  // Engine reads KLIO_OPENROUTER_API_KEY directly via direct httpx.
  assert.match(body, /KLIO_OPENROUTER_API_KEY: \$\{KLIO_OPENROUTER_API_KEY\}/);
});

test("compose body includes KLIO_CUSTOM_BASE_URL + KLIO_CUSTOM_API_KEY env vars", () => {
  const body = renderComposeBody({
    imageTag: "0.3.0",
    jwtSigningKey: "k",
    embeddingModel: "openrouter/openai/text-embedding-3-small",
    extractionModel: "openrouter/anthropic/claude-3-5-haiku",
  });
  assert.match(body, /KLIO_CUSTOM_BASE_URL: \$\{KLIO_CUSTOM_BASE_URL\}/);
  assert.match(body, /KLIO_CUSTOM_API_KEY: \$\{KLIO_CUSTOM_API_KEY\}/);
});

test("compose body includes KLIO_EMBEDDING_DIM env var", () => {
  const body = renderComposeBody({
    imageTag: "0.3.0",
    jwtSigningKey: "k",
    embeddingModel: "custom/x",
    extractionModel: "custom/y",
  });
  assert.match(body, /KLIO_EMBEDDING_DIM: \$\{KLIO_EMBEDDING_DIM\}/);
});

test("compose body no longer emits dead OPENROUTER_API_KEY env", () => {
  const body = renderComposeBody({
    imageTag: "0.3.0",
    jwtSigningKey: "k",
    embeddingModel: "openrouter/x",
    extractionModel: "openrouter/y",
  });
  // KLIO_OPENROUTER_API_KEY remains; bare OPENROUTER_API_KEY is dropped
  // (the LiteLLM-era pass-through is no longer needed after 0.3.0's
  // direct-httpx routing).
  assert.match(body, /KLIO_OPENROUTER_API_KEY: \$\{KLIO_OPENROUTER_API_KEY\}/);
  assert.doesNotMatch(body, /^\s*OPENROUTER_API_KEY:/m);
});

test("compose body sets KLIO_OLLAMA_API_BASE so the engine can reach the host's Ollama", () => {
  // 0.4.1 production bug: when the user picks Ollama, the engine
  // container defaults to `http://127.0.0.1:11434` (the engine's OWN
  // loopback), not the host's. The host has the user's native
  // Ollama daemon. The compose template must thread
  // `host.docker.internal:11434` through so the engine can talk to
  // the host (the `extra_hosts: host.docker.internal:host-gateway`
  // mapping above this env block makes that work on Linux too).
  const body = renderComposeBody({
    imageTag: "0.4.2",
    jwtSigningKey: "k",
    embeddingModel: "ollama/nomic-embed-text",
    extractionModel: "ollama/qwen2.5:7b-instruct",
  });
  assert.match(
    body,
    /KLIO_OLLAMA_API_BASE:.*host\.docker\.internal:11434/,
    "engine env must reference the host gateway by default",
  );
});

test("compose body's KLIO_OLLAMA_API_BASE is overridable by the operator", () => {
  // The default must be a default — not a hardcoded value — so an
  // operator who runs Ollama on a different host or port can
  // override via `~/.klio/.env` without re-rendering compose.
  const body = renderComposeBody({
    imageTag: "0.4.2",
    jwtSigningKey: "k",
    embeddingModel: "ollama/nomic-embed-text",
    extractionModel: "ollama/qwen2.5:7b-instruct",
  });
  // `${VAR:-default}` is the compose-spec form for "use VAR if set,
  // else fall back". Either side of the `:-` is acceptable.
  assert.match(
    body,
    /KLIO_OLLAMA_API_BASE:\s*\$\{KLIO_OLLAMA_API_BASE:-/,
    "default must be expressed as ${KLIO_OLLAMA_API_BASE:-...} so an operator can override",
  );
});

test("compose body mounts ~/.klio rw into bridge so the updater can write update-state.json", () => {
  const body = renderComposeBody({
    imageTag: "0.6.0",
    jwtSigningKey: "k",
    embeddingModel: "ollama/nomic-embed-text",
    extractionModel: "ollama/qwen2.5:7b-instruct",
  });
  // Bridge service block must mount the host's ~/.klio at /host/.klio.
  // Use a multi-line regex: the ~/.klio mount must appear inside the
  // bridge: service block specifically, not somewhere unrelated.
  assert.match(
    body,
    /bridge:[\s\S]*?volumes:[\s\S]*?\$\{HOME\}\/\.klio:\/host\/\.klio:rw/,
  );
});

test("compose body mounts ~/.klio ro into trust-app so the dashboard can read update-state.json", () => {
  const body = renderComposeBody({
    imageTag: "0.6.0",
    jwtSigningKey: "k",
    embeddingModel: "ollama/nomic-embed-text",
    extractionModel: "ollama/qwen2.5:7b-instruct",
  });
  assert.match(
    body,
    /trust-app:[\s\S]*?volumes:[\s\S]*?\$\{HOME\}\/\.klio:\/host\/\.klio:ro/,
  );
});
