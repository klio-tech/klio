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
import { runEmailClaim } from "../src/email.js";

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

// ---------------------------------------------------------------------
// Phase 6 / 6 · Email-claim sub-step (D2)
// ---------------------------------------------------------------------
//
// The Phase 6 email-claim sub-prompt runs at the very end of init —
// after the wow-moment's recall confirms. The user can hit Enter to
// skip, or type an email which triggers POST /v1/auth/login-link.
// The sub-step is non-blocking: any failure path (skip, garbage,
// HTTP 5xx) returns control cleanly to init without aborting.
//
// We test the orchestrator (`runEmailClaim` in `src/email.ts`) rather
// than driving `init()` end-to-end. Driving init() would require a
// live Docker stack + engine; the orchestrator carries every behaviour
// the new sub-step is responsible for (header copy, prompt, validate,
// POST, retry-on-garbage). Mirrors the wow.test.ts pattern, where the
// `runWowMoment` orchestrator is the unit under test rather than the
// init.ts caller.

test("init Phase 6 email sub-step: skip (empty input) completes init cleanly", async () => {
  // User just hits enter. The prompt module substitutes the default
  // ("skip") on empty input, but we simulate the full empty-string
  // path here — the orchestrator must treat both the same way.
  let fetchCalls = 0;
  const fetchFn = (async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const result = await runEmailClaim({
    engineURL: "http://127.0.0.1:8000",
    promptFn: async () => "",
    log: () => {},
    fetchFn,
  });

  assert.equal(result.kind, "skipped");
  assert.equal(fetchCalls, 0, "no /v1/auth/login-link POST on skip");
});

test("init Phase 6 email sub-step: literal 'skip' input is treated as a skip", async () => {
  // The default placeholder is the word "skip" — a curious user who
  // types it literally must land on the same no-op path. Belt-and-
  // braces against a future change to the prompt's default-handling
  // semantics.
  let fetchCalls = 0;
  const fetchFn = (async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const result = await runEmailClaim({
    engineURL: "http://127.0.0.1:8000",
    promptFn: async () => "skip",
    log: () => {},
    fetchFn,
  });

  assert.equal(result.kind, "skipped");
  assert.equal(fetchCalls, 0);
});

test("init Phase 6 email sub-step: valid email triggers POST /v1/auth/login-link", async () => {
  const captured: { url?: string; body?: string; method?: string } = {};
  const fetchFn = (async (
    input: RequestInfo | URL,
    initOpts?: RequestInit,
  ): Promise<Response> => {
    captured.url = String(input);
    captured.body = String(initOpts?.body ?? "");
    captured.method = initOpts?.method;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const result = await runEmailClaim({
    engineURL: "http://127.0.0.1:8000",
    promptFn: async () => "abhi@example.com",
    log: () => {},
    fetchFn,
  });

  assert.equal(result.kind, "sent");
  assert.equal(captured.url, "http://127.0.0.1:8000/v1/auth/login-link");
  assert.equal(captured.method, "POST");
  assert.match(captured.body || "", /"email":\s*"abhi@example\.com"/);
});

test("init Phase 6 email sub-step: garbage input re-prompts up to 3 times then skips", async () => {
  // User types non-emails three times in a row. The orchestrator
  // must (a) call promptFn three times, (b) emit a hint between
  // attempts, (c) NEVER call fetch, and (d) return skipped so init
  // can continue.
  const replies = ["foo", "bar", "baz"];
  let promptCalls = 0;
  let fetchCalls = 0;
  const promptFn = async () => {
    const r = replies[promptCalls];
    promptCalls += 1;
    return r ?? "";
  };
  const fetchFn = (async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const lines: string[] = [];

  const result = await runEmailClaim({
    engineURL: "http://127.0.0.1:8000",
    promptFn,
    log: (line) => lines.push(line),
    fetchFn,
  });

  assert.equal(result.kind, "skipped");
  assert.equal(promptCalls, 3, "must re-prompt up to the 3-retry cap");
  assert.equal(fetchCalls, 0, "no POST on garbage-only input");
  // At least one hint line must reference the "email or skip" guidance
  // so the user knows how to opt out without typing more garbage.
  const hint = lines.find((l) => /email or \[skip\]/.test(l));
  assert.ok(hint, "must emit the email-or-skip hint at least once");
});

test("init Phase 6 email sub-step: HTTP failure during link send doesn't abort init", async () => {
  // Engine returns 500. The orchestrator must surface a clean
  // diagnostic (no stack trace, no throw) and return so init can
  // print "Klio is ready." regardless. Email is OPTIONAL — never a
  // gating step.
  const fetchFn = (async () => {
    return new Response("internal error", { status: 500 });
  }) as typeof fetch;
  const lines: string[] = [];

  const result = await runEmailClaim({
    engineURL: "http://127.0.0.1:8000",
    promptFn: async () => "abhi@example.com",
    log: (l) => lines.push(l),
    fetchFn,
  });

  assert.equal(result.kind, "send_failed");
  if (result.kind === "send_failed") {
    assert.equal(result.status, 500);
    assert.equal(result.email, "abhi@example.com");
  }
  // The user-facing message must reference the fallback (configure
  // email) so the user knows they can retry later, plus the HTTP
  // status so a power-user can diagnose.
  const joined = lines.join("\n");
  assert.match(joined, /500/);
  assert.match(joined, /klio configure email/);
});

test("init Phase 6 email sub-step: trailing slashes on engineURL are stripped", async () => {
  // Defensive: callers may pass either http://host:8000 or
  // http://host:8000/ — both must produce the same login-link URL.
  let url: string | undefined;
  const fetchFn = (async (input: RequestInfo | URL): Promise<Response> => {
    url = String(input);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  await runEmailClaim({
    engineURL: "http://127.0.0.1:8000///",
    promptFn: async () => "user@example.com",
    log: () => {},
    fetchFn,
  });

  assert.equal(url, "http://127.0.0.1:8000/v1/auth/login-link");
});

test("InitOptions accepts emailPromptFn + emailFetchFn DI seams", () => {
  // Compile-time assertion: tests + future repair flows wire fakes
  // through the InitOptions struct. If either field disappears or
  // changes shape, the type system will fail this build.
  const opts: InitOptions = {
    imageTag: "0.6.0",
    skipProvider: true,
    skipWow: true,
    skipCommunity: true,
    emailPromptFn: async () => "",
    emailFetchFn: (async () =>
      new Response("{}", { status: 200 })) as typeof fetch,
  };
  assert.equal(typeof opts.emailPromptFn, "function");
  assert.equal(typeof opts.emailFetchFn, "function");
});
