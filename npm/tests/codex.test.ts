// Tests for the Codex adapter.
//
// Each test redirects HOME to a fresh tmpdir via process.env.HOME so
// the adapter's `~/.codex/...` reads/writes are hermetic and cannot
// touch the developer's actual Codex install. The fake home is
// torn down after each test via t.after.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAdapter } from "../src/adapters/codex.js";

type TestCtx = { after: (fn: () => void) => void };

function withFakeHome(t: TestCtx): string {
  const home = mkdtempSync(join(tmpdir(), "klio-codex-test-"));
  const prevHome = process.env.HOME;
  const prevUserprofile = process.env.USERPROFILE;
  process.env.HOME = home;
  // os.homedir() on Windows reads USERPROFILE; harmless on POSIX.
  process.env.USERPROFILE = home;
  t.after(() => {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserprofile;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return home;
}

test("CodexAdapter not installed when ~/.codex absent", (t) => {
  withFakeHome(t);
  assert.equal(new CodexAdapter().installed(), false);
});

test("CodexAdapter installed when ~/.codex directory exists (no config.toml yet)", (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".codex"));
  assert.equal(new CodexAdapter().installed(), true);
});

test("CodexAdapter installed when ~/.codex contains config.toml", (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), "");
  assert.equal(new CodexAdapter().installed(), true);
});

test("CodexAdapter.install creates config with klio entry", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".codex"));

  await new CodexAdapter().install({
    bridgeContainer: "klio-bridge",
    env: { K: "V" },
  });

  const body = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.match(body, /\[mcp_servers\.klio\]/);
  assert.match(body, /command = "docker"/);
  assert.match(body, /args = \["exec", "-i", "klio-bridge", "klio-mcp"\]/);
  assert.match(body, /\[mcp_servers\.klio\.env\]/);
  assert.match(body, /K = "V"/);
});

test("CodexAdapter.install honours a custom bridgeContainer name", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".codex"));

  await new CodexAdapter().install({
    bridgeContainer: "klio-work",
    env: {},
  });

  const body = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.match(body, /args = \["exec", "-i", "klio-work", "klio-mcp"\]/);
});

test("CodexAdapter.install preserves peer servers and unrelated sections", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".codex"));
  writeFileSync(
    join(home, ".codex", "config.toml"),
    `[mcp_servers.fs]
command = "/opt/fs"
args = []

[other_section]
key = "value"
`,
  );

  await new CodexAdapter().install({
    bridgeContainer: "klio-bridge",
    env: {},
  });

  const body = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.match(body, /\[mcp_servers\.fs\]/);
  assert.match(body, /command = "\/opt\/fs"/);
  assert.match(body, /\[mcp_servers\.klio\]/);
  assert.match(body, /\[other_section\]/);
  assert.match(body, /key = "value"/);
});

test("CodexAdapter.install is idempotent", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".codex"));

  const a = new CodexAdapter();
  await a.install({ bridgeContainer: "klio-bridge", env: { K: "V" } });
  const first = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  await a.install({ bridgeContainer: "klio-bridge", env: { K: "V" } });
  const second = readFileSync(join(home, ".codex", "config.toml"), "utf8");

  assert.equal(first, second);
});

test("CodexAdapter.install backs up an existing config.toml", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".codex"));
  const original = `[mcp_servers.fs]
command = "/opt/fs"
args = []
`;
  writeFileSync(join(home, ".codex", "config.toml"), original);

  await new CodexAdapter().install({
    bridgeContainer: "klio-bridge",
    env: {},
  });

  const backups = readdirSync(join(home, ".codex")).filter((f) =>
    f.startsWith("config.toml.klio-backup-"),
  );
  assert.equal(backups.length, 1);
  assert.equal(
    readFileSync(join(home, ".codex", backups[0]), "utf8"),
    original,
  );
});

test("CodexAdapter.install does not create a backup when there is no prior config", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".codex"));

  await new CodexAdapter().install({
    bridgeContainer: "klio-bridge",
    env: {},
  });

  const backups = readdirSync(join(home, ".codex")).filter((f) =>
    f.startsWith("config.toml.klio-backup-"),
  );
  assert.equal(backups.length, 0);
});

test("CodexAdapter.uninstall restores from the latest backup", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".codex"));
  const original = `[mcp_servers.fs]
command = "/opt/fs"
args = []
`;
  writeFileSync(join(home, ".codex", "config.toml"), original);

  const a = new CodexAdapter();
  await a.install({ bridgeContainer: "klio-bridge", env: {} });

  // Confirm the post-install file differs from the original (klio block added).
  const installed = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.notEqual(installed, original);

  await a.uninstall();

  const restored = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.equal(restored, original);
});

test("CodexAdapter.uninstall strips klio in place when no backup exists", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".codex"));
  writeFileSync(
    join(home, ".codex", "config.toml"),
    `[mcp_servers.fs]
command = "/opt/fs"
args = []

[mcp_servers.klio]
command = "docker"
args = ["exec", "-i", "klio-bridge", "klio-mcp"]

[mcp_servers.klio.env]
K = "V"
`,
  );

  await new CodexAdapter().uninstall();

  const body = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.doesNotMatch(body, /\[mcp_servers\.klio\]/);
  assert.doesNotMatch(body, /\[mcp_servers\.klio\.env\]/);
  assert.match(body, /\[mcp_servers\.fs\]/);
});

test("CodexAdapter.uninstall is a no-op when config.toml is absent", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".codex"));

  await new CodexAdapter().uninstall();

  assert.equal(existsSync(join(home, ".codex", "config.toml")), false);
});

test("CodexAdapter.name() returns 'codex'", () => {
  assert.equal(new CodexAdapter().name(), "codex");
});
