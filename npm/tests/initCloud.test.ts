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

/** Build a fetch stub that returns the given status for /verify. */
function verifyFetch(status: number, body = "{}"): typeof fetch {
  return (async () => new Response(body, { status })) as typeof fetch;
}

test("happy path: 200 verify proceeds to wiring + prints reference block", async (t) => {
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
    promptFn: async () => "sk-valid-key-1234",
    fetchFn,
    log: (l) => lines.push(l),
  });

  assert.equal(verifyCalls, 1, "verify the key exactly once on a clean pass");
  const out = lines.join("\n");
  assert.match(out, /Key verified/);
  assert.match(out, /org_x/);
  assert.match(out, /Klio Cloud is ready/);
  assert.match(out, /mcp\.klio\.tech\/mcp/);
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
