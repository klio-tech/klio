import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyProxyEnv,
  readProxyEnv,
  removeProxyEnv,
} from "../src/proxy/claudeCodeProxy.js";
import { describeTradeoffs, wireProxy } from "../src/proxy/wiring.js";
import { readWiringState } from "../src/proxy/state.js";
import { PROXY_BASE_URL } from "../src/proxy/constants.js";

/**
 * A scratch pair of paths so every test exercises the REAL
 * read-merge-write code against a temp directory. Mocking the
 * filesystem here would defeat the purpose: the whole risk this module
 * addresses is what happens to bytes on disk.
 */
function scratch(): { settings: string; state: string } {
  const dir = mkdtempSync(join(tmpdir(), "klio-proxy-wiring-"));
  return { settings: join(dir, "settings.json"), state: join(dir, "proxy-wiring.json") };
}

function write(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function read(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ---------------------------------------------------------------------
// The non-negotiable: other writers' keys survive.
// ---------------------------------------------------------------------

test("another tool's settings.json keys survive our write", () => {
  // ~/.claude/settings.json has several writers that do not coordinate:
  // Claude Code itself (theme, effortLevel, permissions), Klio's own
  // hooks, and anything else the user has installed. A wholesale write
  // by any of them destroys the others' entries — and this file is not
  // in version control, so the loss surfaces days later as "my
  // permissions reset".
  const { settings, state } = scratch();
  const original = {
    theme: "dark",
    effortLevel: "high",
    permissions: {
      allow: ["mcp__klio__recall", "Bash(git status:*)"],
      deny: ["Bash(rm -rf:*)"],
    },
    hooks: {
      SessionStart: [
        { matcher: "*", hooks: [{ type: "command", command: "docker exec -i klio-bridge klio hook session-start" }] },
      ],
    },
    env: { SOME_OTHER_TOOL: "keep-me", PATH_EXTRA: "/opt/thing/bin" },
    statusLine: { type: "command", command: "my-statusline" },
    someUnknownFutureKey: { nested: [1, 2, 3] },
  };
  write(settings, original);

  applyProxyEnv({ settingsPath: settings, statePath: state });

  const after = read(settings);
  assert.equal(after.theme, "dark");
  assert.equal(after.effortLevel, "high");
  assert.deepEqual(after.permissions, original.permissions);
  assert.deepEqual(after.hooks, original.hooks);
  assert.deepEqual(after.statusLine, original.statusLine);
  assert.deepEqual(after.someUnknownFutureKey, original.someUnknownFutureKey);

  // Peer env vars survive too — `env` is shared, not ours.
  assert.equal(after.env.SOME_OTHER_TOOL, "keep-me");
  assert.equal(after.env.PATH_EXTRA, "/opt/thing/bin");

  // And ours were added.
  assert.equal(after.env.ANTHROPIC_BASE_URL, PROXY_BASE_URL);
  assert.equal(after.env.ENABLE_TOOL_SEARCH, "true");
});

test("uninit leaves every other key intact", () => {
  const { settings, state } = scratch();
  write(settings, {
    theme: "dark",
    hooks: { Stop: [{ matcher: "*", hooks: [] }] },
    env: { SOME_OTHER_TOOL: "keep-me" },
  });

  applyProxyEnv({ settingsPath: settings, statePath: state });
  removeProxyEnv({ settingsPath: settings, statePath: state });

  const after = read(settings);
  assert.equal(after.theme, "dark");
  assert.deepEqual(after.hooks, { Stop: [{ matcher: "*", hooks: [] }] });
  assert.equal(after.env.SOME_OTHER_TOOL, "keep-me");
  assert.equal(after.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(after.env.ENABLE_TOOL_SEARCH, undefined);
});

// ---------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------

test("applyProxyEnv creates settings.json when absent", () => {
  const { settings, state } = scratch();
  const result = applyProxyEnv({ settingsPath: settings, statePath: state });

  assert.equal(result.changes.length, 2);
  const after = read(settings);
  assert.equal(after.env.ANTHROPIC_BASE_URL, PROXY_BASE_URL);
  assert.equal(after.env.ENABLE_TOOL_SEARCH, "true");
});

test("ENABLE_TOOL_SEARCH is always written alongside the base URL", () => {
  // Not decoration. Pointing ANTHROPIC_BASE_URL at a non-Anthropic host
  // disables MCP Tool Search by default, costing ~85% on tool schemas.
  // Writing the base URL WITHOUT this flag is a net token loss the user
  // has no way to observe.
  const { settings, state } = scratch();
  applyProxyEnv({ settingsPath: settings, statePath: state });
  assert.equal(read(settings).env.ENABLE_TOOL_SEARCH, "true");
});

test("applyProxyEnv is idempotent and does not rewrite on a no-op", () => {
  const { settings, state } = scratch();
  applyProxyEnv({ settingsPath: settings, statePath: state });
  const firstBytes = readFileSync(settings, "utf8");

  const second = applyProxyEnv({ settingsPath: settings, statePath: state });

  assert.equal(second.changes.length, 0, "second run should report no changes");
  assert.equal(readFileSync(settings, "utf8"), firstBytes, "file should be byte-identical");
});

test("applyProxyEnv records the ORIGINAL prior value, not its own", () => {
  // The bug this guards: re-running init overwrites the recorded prior
  // value with what init itself wrote, so uninit "restores"
  // http://localhost:8787 — the exact thing it exists to undo.
  const { settings, state } = scratch();
  write(settings, { env: { ANTHROPIC_BASE_URL: "https://gateway.corp.internal" } });

  applyProxyEnv({ settingsPath: settings, statePath: state });
  applyProxyEnv({ settingsPath: settings, statePath: state });
  // Simulate another writer clobbering it, then a third init run.
  write(settings, { env: { ANTHROPIC_BASE_URL: "https://elsewhere.example" } });
  applyProxyEnv({ settingsPath: settings, statePath: state });

  const recorded = readWiringState(state).claudeCode?.previous;
  assert.equal(recorded?.ANTHROPIC_BASE_URL, "https://gateway.corp.internal");
});

test("applyProxyEnv preserves a non-object env by replacing only it", () => {
  const { settings, state } = scratch();
  write(settings, { theme: "dark", env: "not-an-object" });

  applyProxyEnv({ settingsPath: settings, statePath: state });

  const after = read(settings);
  assert.equal(after.theme, "dark");
  assert.equal(after.env.ANTHROPIC_BASE_URL, PROXY_BASE_URL);
});

test("applyProxyEnv refuses to write over malformed JSON", () => {
  // Scribbling a merge on top of a partial parse is how a corrupt
  // config becomes an unrecoverable one. Loud beats silent.
  const { settings, state } = scratch();
  mkdirSync(join(settings, ".."), { recursive: true });
  writeFileSync(settings, "{ this is not json");

  assert.throws(
    () => applyProxyEnv({ settingsPath: settings, statePath: state }),
    /not valid JSON/,
  );
  assert.equal(readFileSync(settings, "utf8"), "{ this is not json");
});

// ---------------------------------------------------------------------
// Remove — "exactly what init added, leaving everything else intact"
// ---------------------------------------------------------------------

test("removeProxyEnv restores a pre-existing base URL rather than deleting it", () => {
  // A user pointed at their company's LLM gateway before ever running
  // klio init. Deleting the key on uninit would silently move them to
  // api.anthropic.com — a change they never asked for and cannot see.
  const { settings, state } = scratch();
  write(settings, { env: { ANTHROPIC_BASE_URL: "https://gateway.corp.internal" } });

  applyProxyEnv({ settingsPath: settings, statePath: state });
  assert.equal(read(settings).env.ANTHROPIC_BASE_URL, PROXY_BASE_URL);

  removeProxyEnv({ settingsPath: settings, statePath: state });
  assert.equal(read(settings).env.ANTHROPIC_BASE_URL, "https://gateway.corp.internal");
});

test("removeProxyEnv deletes keys that were absent before", () => {
  const { settings, state } = scratch();
  applyProxyEnv({ settingsPath: settings, statePath: state });
  removeProxyEnv({ settingsPath: settings, statePath: state });

  const after = read(settings);
  // The whole `env` object goes when we emptied it — no vestigial
  // `"env": {}` left behind.
  assert.equal(after.env, undefined);
});

test("removeProxyEnv leaves a value someone else changed", () => {
  const { settings, state } = scratch();
  applyProxyEnv({ settingsPath: settings, statePath: state });

  // Another writer repoints it deliberately after us.
  const current = read(settings);
  current.env.ANTHROPIC_BASE_URL = "https://someone-elses-choice.example";
  write(settings, current);

  const result = removeProxyEnv({ settingsPath: settings, statePath: state });

  assert.equal(
    read(settings).env.ANTHROPIC_BASE_URL,
    "https://someone-elses-choice.example",
    "must not clobber a value we did not write",
  );
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].key, "ANTHROPIC_BASE_URL");
});

test("removeProxyEnv is a no-op when settings.json does not exist", () => {
  const { settings, state } = scratch();
  const result = removeProxyEnv({ settingsPath: settings, statePath: state });
  assert.equal(result.changes.length, 0);
  assert.equal(existsSync(settings), false, "must not create the file it is cleaning up");
});

test("removeProxyEnv works without a state file", () => {
  // The state file is disposable. A user who wiped ~/.klio must still
  // be able to escape the proxy wiring — that is when they need it most.
  const { settings, state } = scratch();
  applyProxyEnv({ settingsPath: settings, statePath: state });

  const result = removeProxyEnv({
    settingsPath: settings,
    statePath: join(state, "..", "does-not-exist.json"),
  });

  assert.equal(result.changes.length, 2);
  assert.equal(read(settings).env, undefined);
});

test("a second uninit is a clean no-op", () => {
  const { settings, state } = scratch();
  applyProxyEnv({ settingsPath: settings, statePath: state });
  removeProxyEnv({ settingsPath: settings, statePath: state });
  const bytes = readFileSync(settings, "utf8");

  const second = removeProxyEnv({ settingsPath: settings, statePath: state });

  assert.equal(second.changes.length, 0);
  assert.equal(readFileSync(settings, "utf8"), bytes);
});

// ---------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------

test("readProxyEnv reports absent keys as null", () => {
  const { settings } = scratch();
  write(settings, { env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL } });

  const current = readProxyEnv(settings);
  assert.equal(current.ANTHROPIC_BASE_URL, PROXY_BASE_URL);
  assert.equal(current.ENABLE_TOOL_SEARCH, null);
});

test("readProxyEnv does not throw on malformed JSON", () => {
  // doctor gathers facts before reporting. Crashing while gathering
  // turns "your settings file is corrupt" into a stack trace.
  const { settings } = scratch();
  mkdirSync(join(settings, ".."), { recursive: true });
  writeFileSync(settings, "not json at all");

  const current = readProxyEnv(settings);
  assert.equal(current.ANTHROPIC_BASE_URL, null);
});

// ---------------------------------------------------------------------
// wireProxy — who actually gets wired
// ---------------------------------------------------------------------
//
// 0.9.6 wired Claude Code whenever it was installed. It should never
// have: hooks already cover Claude Code end to end, a Claude
// subscription never routes to a custom base URL at all, and the cost —
// Remote Control stops working, permanently, with no flag to bring it
// back — is paid in exchange for nothing. 0.9.7 wires the agents that
// have no hooks, and undoes what the older versions did.

test("wireProxy does not point Claude Code at the proxy", () => {
  const { settings, state } = scratch();
  const codexConfig = join(settings, "..", "codex-config.toml");
  write(settings, { theme: "dark" });

  const result = wireProxy({ log: () => {}, claudeSettings: settings, codexConfig, statePath: state });

  const after = read(settings);
  assert.equal(
    after.env,
    undefined,
    `Claude Code must not be wired to the proxy:\n${JSON.stringify(after)}`,
  );
  assert.equal(result.errors.length, 0);
  assert.ok(result.codex, "Codex — which has no hooks — must still be wired");
  assert.match(readFileSync(codexConfig, "utf8"), /klio-proxy/);
});

test("wireProxy restores what an older Klio wrote into Claude Code's settings", () => {
  const { settings, state } = scratch();
  const codexConfig = join(settings, "..", "codex-config.toml");
  write(settings, { theme: "dark" });
  applyProxyEnv({ settingsPath: settings, statePath: state }); // 0.9.6's doing

  const result = wireProxy({ log: () => {}, claudeSettings: settings, codexConfig, statePath: state });

  assert.equal(read(settings).env, undefined, "the migration must undo it");
  assert.equal(result.claudeCodeMigration?.outcome, "restored");
});

test("wireProxy leaves a Claude Code value Klio cannot prove it wrote", () => {
  const { settings, state } = scratch();
  const codexConfig = join(settings, "..", "codex-config.toml");
  write(settings, { env: { ANTHROPIC_BASE_URL: "https://gateway.corp" } });

  wireProxy({ log: () => {}, claudeSettings: settings, codexConfig, statePath: state });

  assert.equal(read(settings).env.ANTHROPIC_BASE_URL, "https://gateway.corp");
});

// --- the consent surface has to be TRUE -------------------------------
//
// `describeTradeoffs` is the informed-consent block: it is what the user
// reads immediately before deciding whether to route every model call
// through a process we installed. It said "This release is PASS-THROUGH
// ONLY — it forwards traffic unchanged", which was true of the Python
// proxy and is false of this one: on Anthropic's messages path this
// proxy appends to `system` and captures the conversation. Being wrong
// there is worse than being silent, and it printed directly above a
// prompt that said the opposite.

test("the trade-offs block does not claim pass-through only", () => {
  const lines: string[] = [];
  describeTradeoffs((l) => lines.push(l));
  const text = lines.join("\n");

  assert.doesNotMatch(text, /pass-?through only/i, `still claims pass-through only:\n${text}`);
  assert.doesNotMatch(text, /forwards traffic\s*\n?\s*unchanged/i);
  // It has to say what it actually does instead.
  assert.match(text, /system/i, "must name the one field it modifies");
  assert.match(text, /captur/i, "must disclose capture");
  // And name the kill switches, so "off" is discoverable at the moment
  // consent is given.
  assert.match(text, /KLIO_PROXY_INJECT/);
  assert.match(text, /KLIO_PROXY_CAPTURE/);
});

test("the trade-offs block names Codex and the API it actually uses", () => {
  const lines: string[] = [];
  describeTradeoffs((l) => lines.push(l));
  const text = lines.join("\n");
  assert.match(text, /codex/i);
  assert.match(text, /responses/i, "must name the API Codex actually uses");
  assert.doesNotMatch(
    text,
    /codex[\s\S]{0,200}pass-?through/i,
    `Codex is no longer pass-through:\n${text}`,
  );
});

// --- what the proxy is FOR ---------------------------------------------
//
// Measured on a real machine, 2026-08-15: ANTHROPIC_BASE_URL set to the
// proxy, proxy healthy in inject+capture, Claude Code restarted — and
// ZERO connections ever reached the proxy, because Claude Code
// authenticates by subscription OAuth and does not route to a custom
// base URL under it. Over the same window the HOOK path wrote 64
// memories and injected on SessionStart. So the proxy adds nothing for
// Claude Code, and this block used to present it as the way Claude Code
// gets team context. Copy that sells a no-op is worse than no copy.

test("the trade-offs block says hooks already cover Claude Code", () => {
  const lines: string[] = [];
  describeTradeoffs((l) => lines.push(l));
  const text = lines.join("\n");

  assert.match(text, /hook/i, "must name the hooks that already do this");
  assert.match(
    text,
    /claude code[\s\S]{0,400}(already|not needed|no need)/i,
    `must say Claude Code is already covered:\n${text}`,
  );
  assert.match(
    text,
    /subscription/i,
    "must warn that a Claude subscription never routes to a custom base URL",
  );
  assert.match(
    text,
    /without hook|no hook|cannot do hook|can't do hook/i,
    "must say who the proxy is actually for",
  );
});

test("the trade-offs block keeps every warning that is still true", () => {
  const lines: string[] = [];
  describeTradeoffs((l) => lines.push(l));
  const text = lines.join("\n");

  assert.match(text, /dead proxy/i, "a dead proxy still blocks agents that DO use it");
  assert.match(text, /klio proxy capture off/);
  assert.match(text, /klio proxy inject off/);
});

// A warning that no longer applies is not a harmless leftover. Both of
// these were consequences of ONE thing — Klio pointing Claude Code's
// ANTHROPIC_BASE_URL at the proxy — which 0.9.7 stopped doing. Left in
// place, the Remote Control bullet tells a user that saying yes costs
// them a feature it no longer costs them, which is a reason to decline
// an integration that would have served their Codex sessions.

test("the trade-offs block no longer says yes costs you Remote Control", () => {
  const lines: string[] = [];
  describeTradeoffs((l) => lines.push(l));
  const text = lines.join("\n");

  // It may — and should — still MENTION Remote Control, to tell someone
  // on 0.9.4–0.9.6 that they are getting it back. What it must not do
  // is present it as a cost of enabling the proxy.
  assert.doesNotMatch(
    text,
    /Remote Control[\s\S]{0,200}(run `klio uninit` to undo|does NOT work with a)/i,
    `Remote Control is no longer a cost of saying yes:\n${text}`,
  );
  assert.match(text, /Remote Control[\s\S]{0,300}(back|restore|no longer)/i);
});

test("the trade-offs block does not ask the user to keep a flag Klio no longer sets", () => {
  const lines: string[] = [];
  describeTradeoffs((l) => lines.push(l));
  const text = lines.join("\n");

  assert.doesNotMatch(
    text,
    /We set ENABLE_TOOL_SEARCH=true|leave it in place/i,
    `Klio no longer writes ENABLE_TOOL_SEARCH into Claude Code:\n${text}`,
  );
});

test("the trade-offs block says Klio does not touch Claude Code's settings", () => {
  const lines: string[] = [];
  describeTradeoffs((l) => lines.push(l));
  const text = lines.join("\n");

  assert.match(
    text,
    /(does not|never|no longer)[\s\S]{0,120}(settings\.json|Claude Code's settings|wire Claude Code)/i,
    `must say Claude Code is not wired:\n${text}`,
  );
});
