// Tests for the minimal TOML reader/writer for Codex MCP config.
//
// Codex's `~/.codex/config.toml` is hand-edited by users; we cannot
// safely round-trip it through a generic TOML parser/serialiser
// (would lose comments + reorder keys). Instead we operate on the
// raw source string and only touch the `[mcp_servers.<name>]` blocks
// we own. These tests pin down the byte-level guarantees of that
// surgical edit.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  upsertMcpServer,
  parseMcpServers,
  removeMcpServer,
} from "../src/adapters/toml.js";

test("upsertMcpServer adds a klio server to an empty config", () => {
  const out = upsertMcpServer("", "klio", {
    command: "docker",
    args: ["exec", "-i", "klio-bridge", "klio-mcp"],
    env: { KLIO_DOCKER_BRIDGE: "klio-bridge" },
  });
  assert.match(out, /\[mcp_servers\.klio\]/);
  assert.match(out, /command = "docker"/);
  assert.match(out, /args = \["exec", "-i", "klio-bridge", "klio-mcp"\]/);
  assert.match(out, /\[mcp_servers\.klio\.env\]/);
  assert.match(out, /KLIO_DOCKER_BRIDGE = "klio-bridge"/);
});

test("upsertMcpServer omits the env subtable when env is empty", () => {
  const out = upsertMcpServer("", "klio", {
    command: "docker",
    args: [],
    env: {},
  });
  assert.match(out, /\[mcp_servers\.klio\]/);
  assert.doesNotMatch(out, /\[mcp_servers\.klio\.env\]/);
});

test("upsertMcpServer omits the env subtable when env is undefined", () => {
  const out = upsertMcpServer("", "klio", {
    command: "docker",
    args: [],
  });
  assert.doesNotMatch(out, /\[mcp_servers\.klio\.env\]/);
});

test("upsertMcpServer replaces an existing klio server but keeps peers", () => {
  const original = `
[mcp_servers.filesystem]
command = "/opt/fs"

[mcp_servers.klio]
command = "/old/path"

[other_section]
key = "value"
`;
  const out = upsertMcpServer(original, "klio", {
    command: "docker",
    args: [],
    env: {},
  });
  assert.match(out, /command = "\/opt\/fs"/);
  assert.match(out, /command = "docker"/);
  assert.doesNotMatch(out, /\/old\/path/);
  assert.match(out, /\[other_section\]/);
  assert.match(out, /key = "value"/);
});

test("upsertMcpServer replaces existing klio's env subtable", () => {
  const original = `[mcp_servers.klio]
command = "/old"
args = []

[mcp_servers.klio.env]
OLD_VAR = "old"

[mcp_servers.other]
command = "/keep"
`;
  const out = upsertMcpServer(original, "klio", {
    command: "docker",
    args: [],
    env: { NEW_VAR: "new" },
  });
  assert.doesNotMatch(out, /OLD_VAR/);
  assert.match(out, /NEW_VAR = "new"/);
  assert.match(out, /\[mcp_servers\.other\]/);
  assert.match(out, /command = "\/keep"/);
});

test("upsertMcpServer is idempotent — running twice yields identical output", () => {
  const entry = {
    command: "docker",
    args: ["exec", "-i", "klio-bridge", "klio-mcp"],
    env: { KLIO_DOCKER_BRIDGE: "klio-bridge" },
  };
  const first = upsertMcpServer("", "klio", entry);
  const second = upsertMcpServer(first, "klio", entry);
  assert.equal(first, second);
});

test("upsertMcpServer preserves leading peer block when appending", () => {
  const original = `[mcp_servers.fs]
command = "/opt/fs"
args = []
`;
  const out = upsertMcpServer(original, "klio", {
    command: "docker",
    args: [],
    env: {},
  });
  assert.match(out, /\[mcp_servers\.fs\]/);
  assert.match(out, /command = "\/opt\/fs"/);
  assert.match(out, /\[mcp_servers\.klio\]/);
});

test("parseMcpServers returns the names present", () => {
  const names = parseMcpServers(`
[mcp_servers.fs]
command = "/x"

[mcp_servers.klio]
command = "/y"
`);
  assert.deepEqual([...names].sort(), ["fs", "klio"]);
});

test("parseMcpServers does not treat env subtable as a server", () => {
  const names = parseMcpServers(`[mcp_servers.klio]
command = "/x"

[mcp_servers.klio.env]
K = "V"
`);
  assert.deepEqual([...names], ["klio"]);
});

test("parseMcpServers returns empty set on empty input", () => {
  assert.equal(parseMcpServers("").size, 0);
});

test("parseMcpServers ignores unrelated top-level tables", () => {
  const names = parseMcpServers(`[server]
host = "localhost"

[mcp_servers.fs]
command = "/x"
`);
  assert.deepEqual([...names], ["fs"]);
});

test("removeMcpServer removes the named entry and its env block", () => {
  const original = `[mcp_servers.fs]
command = "/x"

[mcp_servers.klio]
command = "/y"

[mcp_servers.klio.env]
K = "V"

[other]
k = "v"
`;
  const out = removeMcpServer(original, "klio");
  assert.doesNotMatch(out, /\[mcp_servers\.klio\]/);
  assert.doesNotMatch(out, /\[mcp_servers\.klio\.env\]/);
  assert.doesNotMatch(out, /K = "V"/);
  assert.match(out, /\[mcp_servers\.fs\]/);
  assert.match(out, /\[other\]/);
});

test("removeMcpServer is a no-op when the name is absent", () => {
  const original = `[mcp_servers.fs]
command = "/x"
`;
  assert.equal(removeMcpServer(original, "klio"), original);
});

test("upsertMcpServer escapes special characters in string values", () => {
  const out = upsertMcpServer("", "klio", {
    command: 'docker "weird"',
    args: ['arg with "quote"', "back\\slash"],
    env: { KEY: 'value with "quote"' },
  });
  // JSON.stringify escaping is the round-trip-safe baseline.
  assert.match(out, /command = "docker \\"weird\\""/);
  assert.match(out, /"arg with \\"quote\\""/);
  assert.match(out, /"back\\\\slash"/);
  assert.match(out, /KEY = "value with \\"quote\\""/);
});
