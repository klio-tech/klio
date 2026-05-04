// Tests for the Claude Desktop adapter.
//
// HOME and platform-specific env vars (APPDATA, XDG_CONFIG_HOME) are
// redirected to a fresh tmpdir per test so reads/writes are hermetic
// and cannot touch a real Claude Desktop install. The fake home is
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
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

import { ClaudeDesktopAdapter } from "../src/adapters/claudeDesktop.js";

type TestCtx = { after: (fn: () => void) => void };

/**
 * Redirect HOME (POSIX), USERPROFILE (Windows-via-os.homedir),
 * APPDATA (Windows config-root resolver) and XDG_CONFIG_HOME (Linux
 * config-root resolver) to a fresh tmpdir so the adapter's path
 * resolution finds nothing real and writes nothing real.
 */
function withFakeHome(t: TestCtx): string {
  const home = mkdtempSync(join(tmpdir(), "klio-claude-desktop-test-"));
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // Force the adapter's Linux + Windows branches to fall under
  // `home` regardless of which OS the test runs on.
  process.env.APPDATA = home;
  process.env.XDG_CONFIG_HOME = home;
  t.after(() => {
    process.env.HOME = prev.HOME;
    process.env.USERPROFILE = prev.USERPROFILE;
    process.env.APPDATA = prev.APPDATA;
    process.env.XDG_CONFIG_HOME = prev.XDG_CONFIG_HOME;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return home;
}

/**
 * Compute the config dir path that the adapter will resolve under
 * the current OS, given the fake `home` tmpdir.
 */
function resolveConfigDir(home: string): string {
  if (platform() === "darwin") {
    return join(home, "Library", "Application Support", "Claude");
  }
  if (platform() === "win32") {
    // APPDATA is set to `home`, so the resolver returns home/Claude.
    return join(home, "Claude");
  }
  // Linux: XDG_CONFIG_HOME=home, so resolver returns home/Claude.
  return join(home, "Claude");
}

test("ClaudeDesktopAdapter.name returns 'claude-desktop'", () => {
  assert.equal(new ClaudeDesktopAdapter().name(), "claude-desktop");
});

test("not installed when Claude Desktop config dir absent", (t) => {
  withFakeHome(t);
  assert.equal(new ClaudeDesktopAdapter().installed(), false);
});

test("installed when Claude Desktop config dir exists (no JSON yet)", (t) => {
  const home = withFakeHome(t);
  mkdirSync(resolveConfigDir(home), { recursive: true });
  assert.equal(new ClaudeDesktopAdapter().installed(), true);
});

test("install creates claude_desktop_config.json with the klio entry", async (t) => {
  const home = withFakeHome(t);
  const dir = resolveConfigDir(home);
  mkdirSync(dir, { recursive: true });

  await new ClaudeDesktopAdapter().install({
    bridgeContainer: "klio-bridge",
    env: {},
  });

  const path = join(dir, "claude_desktop_config.json");
  assert.equal(existsSync(path), true);
  const body = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(body.mcpServers.klio, {
    command: "docker",
    args: ["exec", "-i", "klio-bridge", "klio-mcp"],
    env: {},
  });
});

test("install threads bridgeContainer + env into the JSON", async (t) => {
  const home = withFakeHome(t);
  const dir = resolveConfigDir(home);
  mkdirSync(dir, { recursive: true });

  await new ClaudeDesktopAdapter().install({
    bridgeContainer: "custom-bridge",
    env: { KLIO_PROFILE: "work" },
  });

  const body = JSON.parse(
    readFileSync(join(dir, "claude_desktop_config.json"), "utf8"),
  );
  assert.equal(body.mcpServers.klio.args[2], "custom-bridge");
  assert.deepEqual(body.mcpServers.klio.env, { KLIO_PROFILE: "work" });
});

test("install preserves peer MCP servers + unrelated keys", async (t) => {
  const home = withFakeHome(t);
  const dir = resolveConfigDir(home);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude_desktop_config.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        mcpServers: {
          filesystem: { command: "/opt/fs", args: ["--root", "/srv"] },
        },
        otherKey: { stuff: "preserve me" },
      },
      null,
      2,
    ),
  );

  await new ClaudeDesktopAdapter().install({
    bridgeContainer: "klio-bridge",
    env: {},
  });

  const body = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(body.mcpServers.filesystem, {
    command: "/opt/fs",
    args: ["--root", "/srv"],
  });
  assert.deepEqual(body.otherKey, { stuff: "preserve me" });
  assert.ok(body.mcpServers.klio);
});

test("install is idempotent", async (t) => {
  const home = withFakeHome(t);
  const dir = resolveConfigDir(home);
  mkdirSync(dir, { recursive: true });

  const a = new ClaudeDesktopAdapter();
  await a.install({ bridgeContainer: "klio-bridge", env: { K: "V" } });
  const first = readFileSync(
    join(dir, "claude_desktop_config.json"),
    "utf8",
  );
  await a.install({ bridgeContainer: "klio-bridge", env: { K: "V" } });
  const second = readFileSync(
    join(dir, "claude_desktop_config.json"),
    "utf8",
  );

  assert.equal(first, second);
});

test("install backs up an existing config file", async (t) => {
  const home = withFakeHome(t);
  const dir = resolveConfigDir(home);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude_desktop_config.json");
  writeFileSync(path, JSON.stringify({ existingKey: 1 }));

  await new ClaudeDesktopAdapter().install({
    bridgeContainer: "klio-bridge",
    env: {},
  });

  const backups = readdirSync(dir).filter((f) =>
    f.startsWith("claude_desktop_config.json.klio-backup-"),
  );
  assert.ok(backups.length >= 1, "expected at least one timestamped backup");
});

test("uninstall restores from backup when one exists", async (t) => {
  const home = withFakeHome(t);
  const dir = resolveConfigDir(home);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude_desktop_config.json");
  const original = JSON.stringify({ mcpServers: { peer: { command: "/p" } } });
  writeFileSync(path, original);

  const a = new ClaudeDesktopAdapter();
  await a.install({ bridgeContainer: "klio-bridge", env: {} });
  await a.uninstall();

  assert.equal(readFileSync(path, "utf8"), original);
});

test("uninstall strips klio in place when no backup exists", async (t) => {
  const home = withFakeHome(t);
  const dir = resolveConfigDir(home);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude_desktop_config.json");
  // Hand-write a config with klio + a peer; no backup file.
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: {
        klio: { command: "docker", args: [] },
        peer: { command: "/peer" },
      },
    }),
  );

  await new ClaudeDesktopAdapter().uninstall();

  const body = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(body.mcpServers.klio, undefined);
  assert.deepEqual(body.mcpServers.peer, { command: "/peer" });
});

test("uninstall is a no-op when config file is absent", async (t) => {
  const home = withFakeHome(t);
  const dir = resolveConfigDir(home);
  mkdirSync(dir, { recursive: true });
  // No file written.

  await new ClaudeDesktopAdapter().uninstall();

  // Should not throw, should not create the file.
  assert.equal(
    existsSync(join(dir, "claude_desktop_config.json")),
    false,
  );
});

test("install drops empty mcpServers map when only klio is present and removed via uninstall", async (t) => {
  const home = withFakeHome(t);
  const dir = resolveConfigDir(home);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude_desktop_config.json");
  writeFileSync(path, JSON.stringify({ mcpServers: {} }));

  const a = new ClaudeDesktopAdapter();
  await a.install({ bridgeContainer: "klio-bridge", env: {} });
  // Drop the backup file so uninstall takes the in-place strip path.
  for (const f of readdirSync(dir)) {
    if (f.startsWith("claude_desktop_config.json.klio-backup-")) {
      rmSync(join(dir, f));
    }
  }
  await a.uninstall();

  const body = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(body.mcpServers, undefined);
});
