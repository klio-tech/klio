// Tests for the cloud-mode init orchestrator (src/commands/initCloud.ts).
//
// Drives the flow with injected prompt + fetch + claude-CLI stubs so
// no TTY, network, or subprocess is touched. HOME is redirected to a
// fresh tmpdir so the agent-wiring step (which runs after a successful
// verify) writes into a throwaway home rather than the dev machine.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initCloud } from "../src/commands/initCloud.js";

type TestCtx = { after: (fn: () => void) => void };

/**
 * Redirect HOME so no agents are detected (empty fake home) — keeps
 * these tests focused on the verify loop without exercising the
 * file-writing adapters. XDG is pinned too so OpenCode detection
 * can't leak in from the dev machine.
 */
function withEmptyFakeHome(t: TestCtx): string {
  const home = mkdtempSync(join(tmpdir(), "klio-initcloud-test-"));
  const prevHome = process.env.HOME;
  const prevUserprofile = process.env.USERPROFILE;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  t.after(() => {
    // initCloud now sets a non-zero exit code when it wires nothing, which is
    // the correct behaviour and would otherwise fail the whole test FILE even
    // though every subtest passed. Reset centrally, since every test here uses
    // this fixture; the tests that care assert the code before returning.
    process.exitCode = 0;
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserprofile;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return home;
}

/**
 * No-op phase banners.
 *
 * `phaseHeader`/`phaseRecap` write to `process.stdout` directly, which under
 * `node --test` is also the runner's IPC channel. The banner's box-drawing
 * rule is multi-byte, and a frame split across it corrupts the stream — the
 * runner then reports "Unable to deserialize cloned data" against whichever
 * file was mid-write, which is not necessarily this one. Every test here
 * injects these so the suite produces no raw stdout.
 */
const SILENT_BANNER = { header: () => {}, recap: () => {} };

/** Build a fetch stub that returns the given status for /verify. */
function verifyFetch(status: number, body = "{}"): typeof fetch {
  return (async () => new Response(body, { status })) as typeof fetch;
}

/**
 * NOTE THE FIXTURE: `withEmptyFakeHome` means NO agent is detectable, so this
 * has always exercised the zero-wired path. It used to assert "Klio Cloud is
 * ready" — i.e. it encoded the defect, and would have gone on passing while
 * users were told a no-op install had succeeded. It now asserts what that path
 * must actually say.
 */
test("verified key with NO agents detected reports an incomplete install", async (t) => {
  withEmptyFakeHome(t);
  const lines: string[] = [];
  let verifyCalls = 0;
  const fetchFn = (async () => {
    verifyCalls += 1;
    return new Response(JSON.stringify({ valid: true, org_id: "org_x" }), {
      status: 200,
    });
  }) as typeof fetch;

  await initCloud({
    phaseFns: SILENT_BANNER,
    promptFn: async () => "sk-valid-key-1234",
    fetchFn,
    log: (l) => lines.push(l),
  });

  assert.equal(verifyCalls, 1, "verify the key exactly once on a clean pass");
  const out = lines.join("\n");
  assert.match(out, /Key verified/);
  assert.match(out, /org_x/);
  assert.match(out, /NOTHING WILL BE CAPTURED/);
  assert.doesNotMatch(out, /Klio Cloud is ready/);
  assert.doesNotMatch(out, /agents are talking to Klio Cloud/);
  // It must still tell them the key is fine and what to do next.
  assert.match(out, /Your key works/);
  assert.match(out, /Start Claude Code/);
  assert.match(out, /mcp\.klio\.tech\/mcp/);
  // And it must exit non-zero so this is distinguishable from success.
  assert.equal(process.exitCode, 1);
  // Key shown masked only — never the full secret.
  assert.match(out, /••••1234/);
  assert.doesNotMatch(out, /sk-valid-key-1234/);
});

test("403 missing scope: re-prompts with the scope message, then a valid key proceeds", async (t) => {
  withEmptyFakeHome(t);
  const lines: string[] = [];
  const keys = ["sk-no-scope", "sk-with-scope-9999"];
  let i = 0;
  let call = 0;
  const fetchFn = (async () => {
    call += 1;
    // First key → 403 (missing scope), second → 200.
    return call === 1
      ? new Response("forbidden", { status: 403 })
      : new Response(JSON.stringify({ valid: true }), { status: 200 });
  }) as typeof fetch;

  await initCloud({
    phaseFns: SILENT_BANNER,
    promptFn: async () => keys[i++] ?? "",
    fetchFn,
    log: (l) => lines.push(l),
  });

  const out = lines.join("\n");
  assert.match(out, /lacks the `memory` scope/i);
  assert.match(out, /Key verified/);
  assert.equal(i, 2, "must re-prompt after the missing-scope key");
});

test("401 invalid key: re-prompts, then a valid key proceeds", async (t) => {
  withEmptyFakeHome(t);
  const lines: string[] = [];
  const keys = ["sk-bad", "sk-good-4321"];
  let i = 0;
  let call = 0;
  const fetchFn = (async () => {
    call += 1;
    return call === 1
      ? new Response("unauthorized", { status: 401 })
      : new Response(JSON.stringify({ valid: true }), { status: 200 });
  }) as typeof fetch;

  await initCloud({
    phaseFns: SILENT_BANNER,
    promptFn: async () => keys[i++] ?? "",
    fetchFn,
    log: (l) => lines.push(l),
  });

  const out = lines.join("\n");
  assert.match(out, /Key invalid/i);
  assert.match(out, /Key verified/);
  assert.equal(i, 2);
});

test("network error: surfaces a message and offers retry; abort returns cleanly", async (t) => {
  withEmptyFakeHome(t);
  const lines: string[] = [];
  // promptFn sequence: key, then "n" to decline the retry.
  const replies = ["sk-key", "n"];
  let i = 0;
  const fetchFn = (async () => {
    throw new Error("getaddrinfo ENOTFOUND mcp.klio.tech");
  }) as typeof fetch;

  await initCloud({
    phaseFns: SILENT_BANNER,
    promptFn: async () => replies[i++] ?? "",
    fetchFn,
    log: (l) => lines.push(l),
  });

  const out = lines.join("\n");
  assert.match(out, /Couldn't reach the Klio brain/);
  assert.match(out, /ENOTFOUND/);
  assert.match(out, /Aborted/);
  // Never reached the wiring / ready block.
  assert.doesNotMatch(out, /Klio Cloud is ready/);
});

test("empty key input re-prompts before verifying", async (t) => {
  withEmptyFakeHome(t);
  const lines: string[] = [];
  const replies = ["", "   ", "sk-real-5555"];
  let i = 0;
  let verifyCalls = 0;
  const fetchFn = (async () => {
    verifyCalls += 1;
    return new Response(JSON.stringify({ valid: true }), { status: 200 });
  }) as typeof fetch;

  await initCloud({
    phaseFns: SILENT_BANNER,
    promptFn: async () => replies[i++] ?? "",
    fetchFn,
    log: (l) => lines.push(l),
  });

  assert.equal(verifyCalls, 1, "blank keys never hit /verify");
  assert.match(lines.join("\n"), /can't be empty/);
  assert.match(lines.join("\n"), /Key verified/);
});

test("attempt cap: repeated invalid keys eventually abort without crashing", async (t) => {
  withEmptyFakeHome(t);
  const lines: string[] = [];
  let i = 0;
  const fetchFn = verifyFetch(401, "nope");

  await initCloud({
    phaseFns: SILENT_BANNER,
    promptFn: async () => `sk-bad-${i++}`,
    fetchFn,
    log: (l) => lines.push(l),
  });

  const out = lines.join("\n");
  assert.match(out, /Couldn't verify a key after several attempts/);
  assert.doesNotMatch(out, /Klio Cloud is ready/);
});

test("wiring runs after verify: Cursor entry written with headers", async (t) => {
  const home = withEmptyFakeHome(t);
  const { mkdirSync, readFileSync } = await import("node:fs");
  mkdirSync(join(home, ".cursor"));

  await initCloud({
    phaseFns: SILENT_BANNER,
    promptFn: async () => "sk-wire-key-7777",
    fetchFn: verifyFetch(200, JSON.stringify({ valid: true })),
    claudeCliFn: async () => ({ code: 0, stdout: "", stderr: "" }),
    log: () => {},
  });

  const body = JSON.parse(
    readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
  );
  assert.equal(body.mcpServers.klio.url, "https://mcp.klio.tech/mcp");
  assert.equal(body.mcpServers.klio.headers["X-Vex-Key"], "sk-wire-key-7777");
  assert.match(body.mcpServers.klio.headers["X-Vex-Agent"], /^klio-/);
});

test("persists cloud config (key + agent id + base url) after verify", async (t) => {
  withEmptyFakeHome(t);
  let saved: { apiKey: string; agentId: string; baseUrl: string } | undefined;

  await initCloud({
    phaseFns: SILENT_BANNER,
    promptFn: async () => "sk-cfg-key-2468",
    fetchFn: verifyFetch(200, JSON.stringify({ valid: true })),
    claudeCliFn: async () => ({ code: 0, stdout: "", stderr: "" }),
    writeConfigFn: (cfg) => {
      saved = cfg;
    },
    log: () => {},
  });

  assert.ok(saved, "cloud config must be persisted");
  assert.equal(saved!.apiKey, "sk-cfg-key-2468");
  assert.match(saved!.agentId, /^klio-/);
  assert.equal(saved!.baseUrl, "https://mcp.klio.tech");
});

// ---------------------------------------------------------------------------
// Non-interactive key supply (`--key` / KLIO_API_KEY)
//
// These exist so a CODING AGENT can run cloud init on the user's behalf: the
// dashboard hands the user a prompt to paste into Claude Code / Cursor, and
// that agent shells out to `klio init --cloud`. The masked key prompt is the
// one thing in cloud mode that blocks a non-TTY caller, so a supplied key must
// bypass it ENTIRELY — never fall back to prompting, which would hang the
// agent's subshell on a stream that never produces a line.
// ---------------------------------------------------------------------------

/** A prompt stub that fails the test if the flow ever reaches it. */
function forbiddenPrompt(): (opts: {
  message: string;
  default?: string;
  mask?: boolean;
}) => Promise<string> {
  return async (opts) => {
    assert.fail(
      `initCloud must not prompt when a key is supplied (asked: ${opts.message})`,
    );
  };
}

test("supplied key verifies without ever prompting", async (t) => {
  withEmptyFakeHome(t);
  let saved: { apiKey: string } | undefined;
  const lines: string[] = [];

  await initCloud({
    phaseFns: SILENT_BANNER,
    apiKey: "sk-supplied-1234",
    promptFn: forbiddenPrompt(),
    fetchFn: verifyFetch(200, JSON.stringify({ valid: true })),
    claudeCliFn: async () => ({ code: 0, stdout: "", stderr: "" }),
    writeConfigFn: (cfg) => {
      saved = cfg;
    },
    log: (l) => lines.push(l),
  });

  assert.ok(saved, "a supplied key must still be persisted");
  assert.equal(saved!.apiKey, "sk-supplied-1234");
  assert.ok(
    lines.some((l) => l.includes("Key verified")),
    `expected a verified line, got:\n${lines.join("\n")}`,
  );
});

test("supplied key that is invalid aborts instead of falling back to a prompt", async (t) => {
  withEmptyFakeHome(t);
  const lines: string[] = [];

  await initCloud({
    phaseFns: SILENT_BANNER,
    apiKey: "sk-bad-9999",
    promptFn: forbiddenPrompt(),
    fetchFn: verifyFetch(401),
    claudeCliFn: async () => ({ code: 0, stdout: "", stderr: "" }),
    log: (l) => lines.push(l),
  });

  assert.equal(
    process.exitCode,
    1,
    "an unusable supplied key must exit non-zero",
  );
  assert.ok(
    lines.some((l) => l.includes("Key invalid")),
    `expected an invalid-key line, got:\n${lines.join("\n")}`,
  );
});

test("supplied key lacking the memory scope aborts with the scope message", async (t) => {
  withEmptyFakeHome(t);
  const lines: string[] = [];

  await initCloud({
    phaseFns: SILENT_BANNER,
    apiKey: "sk-noscope-5555",
    promptFn: forbiddenPrompt(),
    fetchFn: verifyFetch(403),
    claudeCliFn: async () => ({ code: 0, stdout: "", stderr: "" }),
    log: (l) => lines.push(l),
  });

  assert.equal(process.exitCode, 1);
  assert.ok(
    lines.some((l) => l.includes("memory")),
    `expected the scope message, got:\n${lines.join("\n")}`,
  );
});

test("a blank supplied key is treated as absent and falls back to the prompt", async (t) => {
  withEmptyFakeHome(t);
  let asked = 0;

  await initCloud({
    phaseFns: SILENT_BANNER,
    apiKey: "   ",
    promptFn: async () => {
      asked++;
      return "sk-prompted-4321";
    },
    fetchFn: verifyFetch(200, JSON.stringify({ valid: true })),
    claudeCliFn: async () => ({ code: 0, stdout: "", stderr: "" }),
    log: () => {},
  });

  assert.equal(asked, 1, "a whitespace-only key must not be sent to /verify");
});

test("a network failure on a supplied key aborts rather than asking to retry", async (t) => {
  withEmptyFakeHome(t);
  const lines: string[] = [];

  await initCloud({
    phaseFns: SILENT_BANNER,
    apiKey: "sk-offline-1111",
    promptFn: forbiddenPrompt(),
    fetchFn: (async () => {
      throw new Error("getaddrinfo ENOTFOUND mcp.klio.tech");
    }) as unknown as typeof fetch,
    claudeCliFn: async () => ({ code: 0, stdout: "", stderr: "" }),
    log: (l) => lines.push(l),
  });

  assert.equal(process.exitCode, 1);
  assert.ok(
    lines.some((l) => l.includes("Couldn't reach")),
    `expected a transport message, got:\n${lines.join("\n")}`,
  );
});

// ---------------------------------------------------------------------------
// Final live verification probe
//
// A wired install ends with one more round-trip to /verify so the LAST thing
// printed reflects reality at the moment init finished — and the resolved
// identity (org) is stated in the closing block, where an agent that ran
// `klio init --key` on the user's behalf will read and relay it. The outcome
// is recorded (via the injectable recorder) so `klio status` can show the
// last verification result later.
// ---------------------------------------------------------------------------

test("wired install ends with a live probe and prints the resolved org", async (t) => {
  const home = withEmptyFakeHome(t);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(home, ".cursor"));

  const lines: string[] = [];
  let verifyCalls = 0;
  const recorded: { at: string; ok: boolean; orgId?: string; detail?: string }[] = [];

  await initCloud({
    phaseFns: SILENT_BANNER,
    apiKey: "sk-probe-key-6161",
    promptFn: forbiddenPrompt(),
    fetchFn: (async () => {
      verifyCalls += 1;
      return new Response(JSON.stringify({ valid: true, org_id: "org_live" }), {
        status: 200,
      });
    }) as typeof fetch,
    claudeCliFn: async () => ({ code: 0, stdout: "", stderr: "" }),
    recordVerificationFn: (rec) => recorded.push(rec),
    log: (l) => lines.push(l),
  });

  assert.equal(verifyCalls, 2, "initial verify + one final live probe");
  const out = lines.join("\n");
  assert.match(out, /Live check/);
  assert.match(out, /org_live/);
  assert.match(out, /Klio Cloud is ready/);
  // The closing block states the identity, not just the masked key.
  assert.match(out, /Org:\s+org_live/);

  // Both terminal outcomes were recorded, latest wins for `klio status`.
  assert.ok(recorded.length >= 1, "verification outcomes must be recorded");
  const last = recorded[recorded.length - 1];
  assert.equal(last.ok, true);
  assert.equal(last.orgId, "org_live");
  assert.ok(!Number.isNaN(Date.parse(last.at)), "timestamp must be ISO-parseable");
});

test("a failed final probe warns but does not fail a completed install", async (t) => {
  const home = withEmptyFakeHome(t);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(home, ".cursor"));

  const lines: string[] = [];
  let verifyCalls = 0;
  const recorded: { ok: boolean; detail?: string }[] = [];

  await initCloud({
    phaseFns: SILENT_BANNER,
    apiKey: "sk-flaky-key-8282",
    promptFn: forbiddenPrompt(),
    fetchFn: (async () => {
      verifyCalls += 1;
      if (verifyCalls === 1) {
        return new Response(JSON.stringify({ valid: true }), { status: 200 });
      }
      throw new Error("socket hang up");
    }) as typeof fetch,
    claudeCliFn: async () => ({ code: 0, stdout: "", stderr: "" }),
    recordVerificationFn: (rec) => recorded.push(rec),
    log: (l) => lines.push(l),
  });

  const out = lines.join("\n");
  // The wiring genuinely happened; a transient probe failure must not
  // retract the install or flip the exit code.
  assert.match(out, /Klio Cloud is ready/);
  assert.match(out, /socket hang up/);
  assert.notEqual(process.exitCode, 1);
  const last = recorded[recorded.length - 1];
  assert.equal(last.ok, false);
  assert.match(last.detail ?? "", /socket hang up/);
});

test("a refused supplied key records a failed verification", async (t) => {
  withEmptyFakeHome(t);
  const recorded: { ok: boolean; detail?: string }[] = [];

  await initCloud({
    phaseFns: SILENT_BANNER,
    apiKey: "sk-refused-key-9393",
    promptFn: forbiddenPrompt(),
    fetchFn: verifyFetch(401),
    claudeCliFn: async () => ({ code: 0, stdout: "", stderr: "" }),
    recordVerificationFn: (rec) => recorded.push(rec),
    log: () => {},
  });

  assert.equal(process.exitCode, 1);
  const last = recorded[recorded.length - 1];
  assert.equal(last.ok, false);
});
