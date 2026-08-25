// Tests for `klio quickstart` (src/commands/quickstart.ts).
//
// The command exists so a CODING AGENT (or a human skimming a terminal)
// can learn the whole Klio surface from one deterministic plain-text
// dump: the concept map, the MCP tool list, the CLI commands, and a
// ready-to-paste MCP config snippet for each supported host. These
// tests pin the load-bearing phrases — the endpoint, the auth header,
// each host's config shape, and the key placeholder — so a copy edit
// cannot silently drop the one line an agent needed.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { quickstartText, runQuickstart } from "../src/commands/quickstart.js";

test("quickstart output is deterministic", () => {
  assert.equal(quickstartText(), quickstartText());
});

test("quickstart names the endpoint and auth header", () => {
  const out = quickstartText();
  assert.match(out, /https:\/\/mcp\.klio\.tech\/mcp/);
  assert.match(out, /X-Vex-Key/);
  assert.match(out, /X-Vex-Agent/);
});

test("quickstart covers the concept map", () => {
  const out = quickstartText();
  assert.match(out, /personal node/i);
  assert.match(out, /@username/);
  assert.match(out, /org node/i);
  assert.match(out, /projects/i);
  assert.match(out, /context branch/i);
  assert.match(out, /git-branch/i);
  assert.match(out, /scope/i);
  // The scope rules users actually trip over.
  assert.match(out, /private/i);
  assert.match(out, /share\(\)/);
});

test("quickstart lists every MCP tool", () => {
  const out = quickstartText();
  for (const tool of [
    "recall",
    "remember",
    "decide",
    "note",
    "plan",
    "observe",
    "forget",
    "share",
    "project_create",
    "project_list",
    "project_members",
    "project_grant",
    "project_scope",
    "project_link",
    "branch",
    "space",
    "claim",
    "release",
    "artifact_get",
    "artifact_put",
  ]) {
    assert.match(out, new RegExp(`\\b${tool}\\b`), `missing tool: ${tool}`);
  }
  // The branch tool's actions.
  assert.match(out, /create\|list\|info\|merge\|discard/);
});

test("quickstart lists the CLI commands", () => {
  const out = quickstartText();
  assert.match(out, /klio init --key/);
  assert.match(out, /klio status/);
  assert.match(out, /klio doctor/);
  assert.match(out, /klio quickstart/);
});

test("quickstart carries a config snippet per host, with a key placeholder", () => {
  const out = quickstartText();

  // claude-code: HTTP transport with headers (registered via the CLI).
  assert.match(out, /claude-code/);
  assert.match(out, /claude mcp add-json/);
  assert.match(out, /"type":\s*"http"/);

  // claude-desktop: stdio bridge through mcp-remote with --header flags.
  assert.match(out, /claude-desktop/);
  assert.match(out, /claude_desktop_config\.json/);
  assert.match(out, /mcp-remote/);
  assert.match(out, /--header/);

  // codex: TOML table with the http_headers sub-table.
  assert.match(out, /codex/);
  assert.match(out, /config\.toml/);
  assert.match(out, /\[mcp_servers\.klio\]/);
  assert.match(out, /\[mcp_servers\.klio\.http_headers\]/);

  // cursor: mcp.json with url + headers.
  assert.match(out, /cursor/);
  assert.match(out, /mcp\.json/);
  assert.match(out, /"mcpServers"/);

  // Every snippet uses the placeholder — never a real-looking key.
  assert.match(out, /YOUR_KLIO_API_KEY/);
  const placeholders = out.match(/YOUR_KLIO_API_KEY/g) ?? [];
  assert.ok(
    placeholders.length >= 4,
    `expected the placeholder in all four snippets, saw ${placeholders.length}`,
  );
});

test("runQuickstart writes the text through the injected sink", () => {
  const chunks: string[] = [];
  runQuickstart({ write: (s) => chunks.push(s) });
  assert.equal(chunks.join(""), quickstartText() + "\n");
});
