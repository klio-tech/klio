// Unit tests for the Klio Cloud client primitives (src/cloud.ts):
// key verification against /verify, the deterministic agent-id
// derivation, and key masking. Every network call is driven through
// an injected fetch stub so the suite never touches mcp.klio.tech.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CLOUD_MCP_URL,
  CLOUD_VERIFY_URL,
  VEX_KEY_HEADER,
  deriveAgentId,
  maskKey,
  perToolAgentId,
  verifyCloudKey,
} from "../src/cloud.js";

test("CLOUD_* endpoints point at the hosted brain", () => {
  assert.equal(CLOUD_MCP_URL, "https://mcp.klio.tech/mcp");
  assert.equal(CLOUD_VERIFY_URL, "https://mcp.klio.tech/verify");
});

test("verifyCloudKey: 200 with memory scope → valid (+ org_id)", async () => {
  const captured: { url?: string; method?: string; key?: string } = {};
  const fetchFn = (async (
    input: RequestInfo | URL,
    initOpts?: RequestInit,
  ): Promise<Response> => {
    captured.url = String(input);
    captured.method = initOpts?.method;
    captured.key = new Headers(initOpts?.headers).get(VEX_KEY_HEADER) ?? undefined;
    return new Response(
      JSON.stringify({ valid: true, org_id: "org_123", scopes: ["memory"] }),
      { status: 200 },
    );
  }) as typeof fetch;

  const result = await verifyCloudKey("sk-test-key", fetchFn);

  assert.equal(result.kind, "valid");
  if (result.kind === "valid") assert.equal(result.orgId, "org_123");
  assert.equal(captured.url, CLOUD_VERIFY_URL);
  assert.equal(captured.method, "GET");
  assert.equal(captured.key, "sk-test-key", "must send the key in X-Vex-Key");
});

test("verifyCloudKey: 200 without org_id still resolves valid", async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ valid: true }), { status: 200 })) as typeof fetch;

  const result = await verifyCloudKey("k", fetchFn);
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") assert.equal(result.orgId, undefined);
});

test("verifyCloudKey: 403 → missing_scope", async () => {
  const fetchFn = (async () =>
    new Response("forbidden", { status: 403 })) as typeof fetch;

  const result = await verifyCloudKey("k", fetchFn);
  assert.equal(result.kind, "missing_scope");
});

test("verifyCloudKey: 401 → invalid", async () => {
  const fetchFn = (async () =>
    new Response("unauthorized", { status: 401 })) as typeof fetch;

  const result = await verifyCloudKey("k", fetchFn);
  assert.equal(result.kind, "invalid");
  if (result.kind === "invalid") assert.equal(result.status, 401);
});

test("verifyCloudKey: 500 collapses to invalid (non-200/403)", async () => {
  const fetchFn = (async () =>
    new Response("boom", { status: 500 })) as typeof fetch;

  const result = await verifyCloudKey("k", fetchFn);
  assert.equal(result.kind, "invalid");
  if (result.kind === "invalid") assert.equal(result.status, 500);
});

test("verifyCloudKey: fetch throws → network_error, never crashes", async () => {
  const fetchFn = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;

  const result = await verifyCloudKey("k", fetchFn);
  assert.equal(result.kind, "network_error");
  if (result.kind === "network_error") assert.match(result.message, /ECONNREFUSED/);
});

test("verifyCloudKey: malformed 200 body still resolves valid (org_id optional)", async () => {
  const fetchFn = (async () =>
    new Response("not json", { status: 200 })) as typeof fetch;

  const result = await verifyCloudKey("k", fetchFn);
  assert.equal(result.kind, "valid");
  if (result.kind === "valid") assert.equal(result.orgId, undefined);
});

test("deriveAgentId: sanitizes + prefixes the hostname deterministically", () => {
  assert.equal(deriveAgentId("MyMac.local"), "klio-mymac-local");
  assert.equal(deriveAgentId("host_name 01"), "klio-host-name-01");
  // Deterministic — same input twice yields the same id.
  assert.equal(deriveAgentId("Foo.Bar"), deriveAgentId("Foo.Bar"));
});

test("deriveAgentId: trims leading/trailing separators", () => {
  assert.equal(deriveAgentId("--weird--"), "klio-weird");
  assert.equal(deriveAgentId("...dots..."), "klio-dots");
});

test("deriveAgentId: empty / punctuation-only host falls back", () => {
  assert.equal(deriveAgentId(""), "klio-unknown");
  assert.equal(deriveAgentId("!!!"), "klio-unknown");
});

test("deriveAgentId: caps the sanitized label length", () => {
  const longHost = "a".repeat(200);
  const id = deriveAgentId(longHost);
  // "klio-" prefix + at most 63 sanitized chars.
  assert.ok(id.startsWith("klio-"));
  assert.ok(id.length <= "klio-".length + 63, `id too long: ${id.length}`);
});

test("perToolAgentId: appends the tool to the machine id with a `/`", () => {
  assert.equal(perToolAgentId("klio-mac", "cursor"), "klio-mac/cursor");
  assert.equal(perToolAgentId("klio-mac", "claude-code"), "klio-mac/claude-code");
});

test("maskKey: shows only the last 4 chars", () => {
  assert.equal(maskKey("sk-abcdefgh1234"), "••••1234");
  assert.equal(maskKey("longsecretkeyvalue"), "••••alue");
});

test("maskKey: fully masks short keys", () => {
  assert.equal(maskKey("abcd"), "••••");
  assert.equal(maskKey("ab"), "••••");
  assert.equal(maskKey(""), "••••");
});
