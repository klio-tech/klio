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

import { OpenCodeAdapter } from "../src/adapters/openCode.js";

type TestCtx = { after: (fn: () => void) => void };

function withFakeHome(t: TestCtx): string {
  const home = mkdtempSync(join(tmpdir(), "klio-opencode-test-"));
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = home;
  // OpenCode reads XDG_CONFIG_HOME; force tests to land under tmpdir
  // regardless of the test runner's actual XDG path.
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  t.after(() => {
    process.env.HOME = prev.HOME;
    process.env.USERPROFILE = prev.USERPROFILE;
    process.env.APPDATA = prev.APPDATA;
    process.env.XDG_CONFIG_HOME = prev.XDG_CONFIG_HOME;
    try { rmSync(home, { recursive: true, force: true }); } catch {}
  });
  return home;
}

const CONFIG_DIR = (home: string) => join(home, ".config", "opencode");
const CONFIG_PATH = (home: string) =>
  join(CONFIG_DIR(home), "opencode.json");

test("OpenCodeAdapter.name returns 'opencode'", () => {
  assert.equal(new OpenCodeAdapter().name(), "opencode");
});

test("not installed when ~/.config/opencode absent", (t) => {
  withFakeHome(t);
  assert.equal(new OpenCodeAdapter().installed(), false);
});

test("installed when ~/.config/opencode exists (no JSON yet)", (t) => {
  const home = withFakeHome(t);
  mkdirSync(CONFIG_DIR(home), { recursive: true });
  assert.equal(new OpenCodeAdapter().installed(), true);
});

test("install creates opencode.json with klio entry shaped correctly", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(CONFIG_DIR(home), { recursive: true });

  await new OpenCodeAdapter().install({
    bridgeContainer: "klio-bridge",
    env: {},
  });

  const body = JSON.parse(readFileSync(CONFIG_PATH(home), "utf8"));
  // CRITICAL: `command` must be a SINGLE ARRAY (command + args
  // together), not separate `command` string + `args` array. This
  // is OpenCode's documented shape and differs from
  // Claude/Cursor/Codex.
  assert.deepEqual(body.mcp.klio.command, [
    "docker", "exec", "-i", "klio-bridge", "klio-mcp",
  ]);
  assert.equal(body.mcp.klio.type, "local");
  assert.equal(body.mcp.klio.enabled, true);
});

test("install threads bridgeContainer + env into the JSON", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(CONFIG_DIR(home), { recursive: true });

  await new OpenCodeAdapter().install({
    bridgeContainer: "custom-bridge",
    env: { KLIO_PROFILE: "work" },
  });

  const body = JSON.parse(readFileSync(CONFIG_PATH(home), "utf8"));
  assert.equal(body.mcp.klio.command[3], "custom-bridge");
  assert.deepEqual(body.mcp.klio.environment, { KLIO_PROFILE: "work" });
});

test("install preserves peer MCP servers + unrelated keys", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(CONFIG_DIR(home), { recursive: true });
  writeFileSync(
    CONFIG_PATH(home),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: { other: { type: "local", command: ["/bin/x"], enabled: true } },
      theme: "dark",
    }, null, 2),
  );

  await new OpenCodeAdapter().install({
    bridgeContainer: "klio-bridge",
    env: {},
  });

  const body = JSON.parse(readFileSync(CONFIG_PATH(home), "utf8"));
  assert.deepEqual(body.mcp.other, {
    type: "local",
    command: ["/bin/x"],
    enabled: true,
  });
  assert.equal(body.theme, "dark");
  assert.ok(body.mcp.klio);
});

test("install is idempotent (byte-equal on second run)", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(CONFIG_DIR(home), { recursive: true });
  const a = new OpenCodeAdapter();
  await a.install({ bridgeContainer: "klio-bridge", env: { K: "V" } });
  const first = readFileSync(CONFIG_PATH(home), "utf8");
  await a.install({ bridgeContainer: "klio-bridge", env: { K: "V" } });
  const second = readFileSync(CONFIG_PATH(home), "utf8");
  assert.equal(first, second);
});

test("install backs up an existing config file", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(CONFIG_DIR(home), { recursive: true });
  writeFileSync(CONFIG_PATH(home), JSON.stringify({ existingKey: 1 }));

  await new OpenCodeAdapter().install({
    bridgeContainer: "klio-bridge", env: {},
  });

  const backups = readdirSync(CONFIG_DIR(home)).filter((f) =>
    f.startsWith("opencode.json.klio-backup-"),
  );
  assert.ok(backups.length >= 1);
});

test("uninstall restores from backup when one exists", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(CONFIG_DIR(home), { recursive: true });
  const original = JSON.stringify({
    mcp: { other: { type: "local", command: ["/p"] } },
  });
  writeFileSync(CONFIG_PATH(home), original);

  const a = new OpenCodeAdapter();
  await a.install({ bridgeContainer: "klio-bridge", env: {} });
  await a.uninstall();

  assert.equal(readFileSync(CONFIG_PATH(home), "utf8"), original);
});

test("uninstall strips klio in place when no backup", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(CONFIG_DIR(home), { recursive: true });
  writeFileSync(
    CONFIG_PATH(home),
    JSON.stringify({
      mcp: {
        klio: { type: "local", command: ["docker"], enabled: true },
        peer: { type: "local", command: ["/peer"], enabled: true },
      },
    }),
  );
  await new OpenCodeAdapter().uninstall();
  const body = JSON.parse(readFileSync(CONFIG_PATH(home), "utf8"));
  assert.equal(body.mcp.klio, undefined);
  assert.deepEqual(body.mcp.peer, {
    type: "local", command: ["/peer"], enabled: true,
  });
});

test("uninstall is no-op when config absent", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(CONFIG_DIR(home), { recursive: true });
  await new OpenCodeAdapter().uninstall();
  assert.equal(existsSync(CONFIG_PATH(home)), false);
});
