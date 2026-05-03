import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderComposeBody } from "../src/compose.js";

test("compose body includes OPENROUTER_API_KEY env var", () => {
  const body = renderComposeBody({
    imageTag: "0.2.0",
    jwtSigningKey: "k",
    embeddingModel: "openrouter/openai/text-embedding-3-small",
    extractionModel: "openrouter/anthropic/claude-3-5-haiku",
  });
  assert.match(body, /KLIO_OPENROUTER_API_KEY/);
  assert.match(body, /OPENROUTER_API_KEY: \$\{KLIO_OPENROUTER_API_KEY\}/);
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
  // Engine reads its native config name AND LiteLLM's convention.
  assert.match(body, /KLIO_OPENROUTER_API_KEY: \$\{KLIO_OPENROUTER_API_KEY\}/);
  assert.match(body, /OPENROUTER_API_KEY: \$\{KLIO_OPENROUTER_API_KEY\}/);
});
