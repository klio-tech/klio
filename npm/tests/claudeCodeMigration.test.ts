// Undoing, unprompted, a change an older Klio made to someone else's
// ~/.claude/settings.json.
//
// This is the riskiest code in the release: it REMOVES env from a file
// the user did not ask us to touch right now, on a machine we cannot
// see. So every case is driven against real files in a temp directory
// through the real read-merge-write path — no mocked filesystem, since
// the entire risk is what happens to bytes on disk.
//
// The matrix, and the answer each case must give:
//
//   Klio's values + Klio's record        → restore
//   Klio's values + record with a prior  → restore THAT prior, not null
//   user-modified value                  → leave alone
//   record missing                       → leave alone
//   record for a different settings file → leave alone
//   record silent about the key          → leave alone
//   no Claude Code at all                → leave alone
//   settings.json that is not JSON       → leave alone, do not throw

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyProxyEnv } from "../src/proxy/claudeCodeProxy.js";
import { migrateClaudeCodeProxyEnv } from "../src/proxy/claudeCodeMigration.js";
import { PROXY_BASE_URL } from "../src/proxy/constants.js";
import { readWiringState } from "../src/proxy/state.js";

function scratch(): { settings: string; state: string } {
  const dir = mkdtempSync(join(tmpdir(), "klio-cc-migrate-"));
  return { settings: join(dir, "settings.json"), state: join(dir, "proxy-wiring.json") };
}

function write(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function read(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

// --- restore ----------------------------------------------------------

test("restores a 0.9.4–0.9.6 install: both keys go, and so does the empty env", () => {
  const { settings, state } = scratch();
  write(settings, { theme: "dark" });
  applyProxyEnv({ settingsPath: settings, statePath: state }); // what 0.9.6 did

  const result = migrateClaudeCodeProxyEnv({ settingsPath: settings, statePath: state });

  assert.equal(result.outcome, "restored");
  const after = read(settings);
  assert.equal(after["env"], undefined, `env should be gone entirely:\n${JSON.stringify(after)}`);
  assert.equal(after["theme"], "dark", "everything else survives");
  assert.equal(
    readWiringState(state).claudeCode,
    undefined,
    "a fully-undone record must be cleared, so a second run is a clean no-op",
  );
});

test("restores the user's own prior value rather than deleting the key", () => {
  const { settings, state } = scratch();
  write(settings, { env: { ANTHROPIC_BASE_URL: "https://gateway.corp", KEEP: "me" } });
  applyProxyEnv({ settingsPath: settings, statePath: state });

  const result = migrateClaudeCodeProxyEnv({ settingsPath: settings, statePath: state });

  assert.equal(result.outcome, "restored");
  const env = read(settings)["env"];
  assert.equal(env["ANTHROPIC_BASE_URL"], "https://gateway.corp");
  assert.equal(env["ENABLE_TOOL_SEARCH"], undefined);
  assert.equal(env["KEEP"], "me", "another writer's variable survives");
});

test("a second migration is a no-op", () => {
  const { settings, state } = scratch();
  write(settings, { theme: "dark" });
  applyProxyEnv({ settingsPath: settings, statePath: state });
  migrateClaudeCodeProxyEnv({ settingsPath: settings, statePath: state });

  const before = readFileSync(settings, "utf8");
  const second = migrateClaudeCodeProxyEnv({ settingsPath: settings, statePath: state });

  assert.equal(second.outcome, "nothing-to-undo");
  assert.equal(readFileSync(settings, "utf8"), before, "the file must not be rewritten");
});

// --- leave alone ------------------------------------------------------

test("a value the user changed themselves is left alone", () => {
  const { settings, state } = scratch();
  write(settings, { theme: "dark" });
  applyProxyEnv({ settingsPath: settings, statePath: state });

  const settingsObj = read(settings);
  settingsObj["env"]["ANTHROPIC_BASE_URL"] = "https://gateway.corp";
  write(settings, settingsObj);

  const result = migrateClaudeCodeProxyEnv({ settingsPath: settings, statePath: state });

  assert.equal(
    read(settings)["env"]["ANTHROPIC_BASE_URL"],
    "https://gateway.corp",
    "a value we did not write must never be clobbered",
  );
  assert.ok(
    result.skipped.some((s) => s.key === "ANTHROPIC_BASE_URL" && s.reason === "changed-elsewhere"),
    `must SAY it left the key alone: ${JSON.stringify(result)}`,
  );
  assert.match(result.detail, /left ANTHROPIC_BASE_URL/);
  // ENABLE_TOOL_SEARCH is still ours and still recorded, so it goes.
  assert.equal(read(settings)["env"]["ENABLE_TOOL_SEARCH"], undefined);
  assert.equal(result.outcome, "restored");
  assert.notEqual(
    readWiringState(state).claudeCode,
    undefined,
    "a partially-undone record must survive, or the leftover key loses its undo info",
  );
});

test("no wiring record means guess nothing: the env stays exactly as found", () => {
  const { settings, state } = scratch();
  write(settings, { env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL, ENABLE_TOOL_SEARCH: "true" } });
  const before = readFileSync(settings, "utf8");

  const result = migrateClaudeCodeProxyEnv({ settingsPath: settings, statePath: state });

  assert.equal(result.outcome, "left-alone");
  assert.equal(readFileSync(settings, "utf8"), before);
  assert.match(result.detail, /no record of setting it/i);
});

test("a record pointing at a different settings file does not authorize a write", () => {
  const { settings, state } = scratch();
  const other = scratch();
  write(other.settings, { theme: "dark" });
  applyProxyEnv({ settingsPath: other.settings, statePath: state }); // record names `other`

  write(settings, { env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL, ENABLE_TOOL_SEARCH: "true" } });
  const before = readFileSync(settings, "utf8");

  const result = migrateClaudeCodeProxyEnv({ settingsPath: settings, statePath: state });

  assert.equal(result.outcome, "left-alone");
  assert.equal(readFileSync(settings, "utf8"), before);
  assert.match(result.detail, /different settings file/i);
});

test("a record that is silent about a key leaves that key alone", () => {
  const { settings, state } = scratch();
  write(settings, { env: { ANTHROPIC_BASE_URL: PROXY_BASE_URL, ENABLE_TOOL_SEARCH: "true" } });
  // A record that mentions only one of the two keys.
  write(state, {
    version: 1,
    claudeCode: {
      settingsPath: settings,
      previous: { ANTHROPIC_BASE_URL: null },
      appliedAt: new Date().toISOString(),
    },
  });

  const result = migrateClaudeCodeProxyEnv({ settingsPath: settings, statePath: state });

  assert.equal(result.outcome, "restored");
  const env = read(settings)["env"];
  assert.equal(env["ANTHROPIC_BASE_URL"], undefined, "the recorded key is undone");
  assert.equal(env["ENABLE_TOOL_SEARCH"], "true", "the unrecorded key is not");
});

test("no Claude Code on the machine is not an error", () => {
  const { settings, state } = scratch();
  const result = migrateClaudeCodeProxyEnv({ settingsPath: settings, statePath: state });
  assert.equal(result.outcome, "not-installed");
  assert.equal(result.changes.length, 0);
});

test("a settings.json that is not JSON is reported, never rewritten", () => {
  const { settings, state } = scratch();
  mkdirSync(join(settings, ".."), { recursive: true });
  writeFileSync(settings, "{ this is not json", "utf8");

  const result = migrateClaudeCodeProxyEnv({ settingsPath: settings, statePath: state });

  assert.equal(result.outcome, "unreadable");
  assert.equal(readFileSync(settings, "utf8"), "{ this is not json");
  assert.match(result.detail, /left it alone/i);
});

test("a settings.json with no env block is nothing to undo", () => {
  const { settings, state } = scratch();
  write(settings, { theme: "dark" });
  const result = migrateClaudeCodeProxyEnv({ settingsPath: settings, statePath: state });
  assert.equal(result.outcome, "nothing-to-undo");
  assert.equal(read(settings)["theme"], "dark");
});
