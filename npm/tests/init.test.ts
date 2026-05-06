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
import {
  curatorEnvLines,
  type CuratorConfig,
} from "../src/curatorConfig.js";
import { askConfirm } from "../src/confirm.js";
import { renderComposeBody } from "../src/compose.js";

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

test("InitOptions accepts a quiet flag", () => {
  // Compile-time assertion via TypeScript: this should typecheck.
  // The runtime check is a sanity guard against the type drifting
  // (e.g. someone narrowing `quiet` to `true` literal by mistake).
  const opts: InitOptions = {
    imageTag: "0.3.0",
    quiet: true,
  };
  assert.equal(opts.quiet, true);
});

test("InitOptions accepts the new 0.3.0 fields together", () => {
  // Compile-time check: the 5-phase init refactor relies on every
  // skip-* flag and the quiet flag composing freely. If any of them
  // becomes mutually exclusive (e.g. quiet implying skipCommunity at
  // the type level by mistake) the type system will fail this build
  // before the test runs.
  const opts: InitOptions = {
    imageTag: "0.3.0",
    quiet: true,
    skipProvider: true,
    skipWow: true,
    skipCommunity: true,
  };
  assert.equal(opts.quiet, true);
  assert.equal(opts.skipProvider, true);
  assert.equal(opts.skipWow, true);
  assert.equal(opts.skipCommunity, true);
});

// ---------------------------------------------------------------------
// Phase 6 / 6 · Memory curator
// ---------------------------------------------------------------------
//
// init.ts itself is structural-only at the unit-test layer (its full
// flow needs Docker + a live engine). The Phase 6 surface area splits
// cleanly into three testable seams that together cover the new
// behaviour without driving the orchestrator end-to-end:
//
//   1. The default-Y path produces the curator-env block the engine
//      reads — verified through `curatorEnvLines` against the same
//      CuratorConfig shape Phase 6 stores in state.
//   2. An explicit "n" produces the disabled variant of that block.
//   3. The Phase 6 prompt uses `askConfirm` (the re-prompting helper),
//      which is the 0.4.2 hardening we want to keep — verified by
//      driving askConfirm with a scripted reply queue and asserting
//      it re-prompts on garbage input before accepting a valid answer.
//   4. The compose template carries the three KLIO_CURATOR_* env
//      lines so a `~/.klio/.env` written by Phase 6 reaches the
//      engine container.

test("init Phase 6: default Y enables curator with hourly cadence + extraction-model fallback", () => {
  // Phase 6 with all-defaults stores this exact CuratorConfig in
  // init.ts state, then appends `curatorEnvLines(state.curatorConfig)`
  // to ~/.klio/.env. We assert on the rendered env block.
  const cfg: CuratorConfig = {
    enabled: true,
    cadence: "hourly",
    model: "",
  };
  const lines = curatorEnvLines(cfg);
  assert.match(lines, /^KLIO_CURATOR_ENABLED=true$/m);
  assert.match(lines, /^KLIO_CURATOR_INTERVAL_SECS=3600$/m);
  // Empty KLIO_CURATOR_MODEL = engine falls back to extraction model.
  assert.match(lines, /^KLIO_CURATOR_MODEL=$/m);
});

test("init Phase 6: explicit n disables the curator", () => {
  // Phase 6 with "n" stores the disabled variant; the rest of init
  // continues unchanged.
  const cfg: CuratorConfig = {
    enabled: false,
    cadence: "disabled",
    model: "",
  };
  const lines = curatorEnvLines(cfg);
  assert.match(lines, /^KLIO_CURATOR_ENABLED=false$/m);
});

test("init Phase 6: re-prompts on garbage input via askConfirm", async () => {
  // Mirrors the 0.4.2 hardening: typing "yeah" must not collapse to
  // "no". askConfirm should re-prompt with a hint and accept the
  // next valid answer ("y") as yes.
  const replies = ["yeah", "y"];
  let promptCalls = 0;
  const hints: string[] = [];
  const promptFn = async () => {
    const r = replies[promptCalls];
    promptCalls += 1;
    return r ?? "";
  };
  const result = await askConfirm(
    promptFn,
    "Enable?",
    true,
    (line) => hints.push(line),
  );
  assert.equal(result, true);
  assert.equal(promptCalls, 2, "must re-prompt after unrecognized input");
  assert.equal(hints.length, 1, "must emit one hint between attempts");
  assert.match(hints[0]!, /yes or no/i);
});

test("compose body declares KLIO_CURATOR_* env vars on the engine service", () => {
  // The three curator env vars must reach the engine container.
  // Defaults (`:-true`, `:-3600`, `:-`) ensure a legacy ~/.klio/.env
  // without the curator block still produces a sensible engine config.
  const body = renderComposeBody({
    imageTag: "0.5.0",
    jwtSigningKey: "k",
    embeddingModel: "openrouter/openai/text-embedding-3-small",
    extractionModel: "openrouter/anthropic/claude-3-5-haiku",
  });
  assert.match(
    body,
    /KLIO_CURATOR_ENABLED:\s*\$\{KLIO_CURATOR_ENABLED:-true\}/,
    "curator-enabled defaults to true if env file omits it",
  );
  assert.match(
    body,
    /KLIO_CURATOR_INTERVAL_SECS:\s*\$\{KLIO_CURATOR_INTERVAL_SECS:-3600\}/,
    "curator-interval defaults to hourly if env file omits it",
  );
  assert.match(
    body,
    /KLIO_CURATOR_MODEL:\s*\$\{KLIO_CURATOR_MODEL:-\}/,
    "curator-model defaults to blank (engine falls back to extraction model)",
  );
});
