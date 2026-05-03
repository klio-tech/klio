// Smoke test for the `klio init` orchestrator. The full end-to-end
// path (docker preflight, OpenRouter probes, container lifecycle,
// MCP wiring, wow moment) is exercised manually in Section 8 — this
// file only confirms the module exports the expected surface and
// the InitOptions type accepts the documented fields. Anything more
// would require driving real Docker + a real OpenRouter key from
// CI, which is out of scope for the unit suite.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { init, type InitOptions } from "../src/commands/init.js";

test("init is exported as a callable", () => {
  assert.equal(typeof init, "function");
});

test("InitOptions accepts the full documented shape", () => {
  // Compile-time check: this object must satisfy InitOptions. If
  // any of these fields stops being valid the type system will
  // fail the build before this test runs.
  const sample: InitOptions = {
    imageTag: "0.2.0",
    email: "user@example.com",
    engineURL: "http://127.0.0.1:8000",
    skipProvider: true,
    skipWow: true,
    skipCommunity: true,
  };
  assert.equal(sample.imageTag, "0.2.0");
  assert.equal(sample.skipProvider, true);
  assert.equal(sample.skipWow, true);
  assert.equal(sample.skipCommunity, true);
});

test("InitOptions only requires imageTag", () => {
  // Only `imageTag` should be required — every other knob defaults
  // to "run the full flow". We verify by constructing the minimal
  // object the type system accepts.
  const minimal: InitOptions = { imageTag: "0.2.0" };
  assert.equal(minimal.imageTag, "0.2.0");
  assert.equal(minimal.email, undefined);
  assert.equal(minimal.skipProvider, undefined);
});
