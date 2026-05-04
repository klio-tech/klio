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
