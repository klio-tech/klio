import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpenClawAdapter } from "../src/adapters/openClaw.js";
import type { ProcessResult, Spawner } from "../src/adapters/spawner.js";

type TestCtx = { after: (fn: () => void) => void };

function withFakeHome(t: TestCtx): string {
  const home = mkdtempSync(join(tmpdir(), "klio-openclaw-test-"));
  const prev = process.env.HOME;
  const prevUserprofile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    process.env.HOME = prev;
    process.env.USERPROFILE = prevUserprofile;
    try { rmSync(home, { recursive: true, force: true }); } catch {}
  });
  return home;
}

type RecordedSpawn = {
  cmd: string;
  args: string[];
};

function makeFakeSpawner(
  result: ProcessResult,
  recordedCalls: RecordedSpawn[],
): Spawner {
  return async (cmd, args) => {
    recordedCalls.push({ cmd, args });
    return result;
  };
}

test("OpenClawAdapter.name returns 'openclaw'", () => {
  assert.equal(new OpenClawAdapter().name(), "openclaw");
});

test("not installed when ~/.openclaw absent", (t) => {
  withFakeHome(t);
  const a = new OpenClawAdapter({
    spawner: async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });
  assert.equal(a.installed(), false);
});

test("installed when ~/.openclaw exists", (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".openclaw"));
  const a = new OpenClawAdapter({
    spawner: async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });
  assert.equal(a.installed(), true);
});

test("install via CLI: spawner called with `mcp set klio '<json>'`", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".openclaw"));
  const calls: RecordedSpawn[] = [];
  const a = new OpenClawAdapter({
    spawner: makeFakeSpawner(
      { exitCode: 0, stdout: "ok", stderr: "" },
      calls,
    ),
  });

  await a.install({ bridgeContainer: "klio-bridge", env: {} });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "openclaw");
  assert.deepEqual(calls[0].args.slice(0, 3), ["mcp", "set", "klio"]);
  // The fourth arg is the JSON payload — parse + assert shape.
  const payload = JSON.parse(calls[0].args[3]);
  assert.equal(payload.command, "docker");
  assert.deepEqual(payload.args, [
    "exec", "-i", "klio-bridge", "klio-mcp",
  ]);
});

test("install via CLI: env passed through in payload", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".openclaw"));
  const calls: RecordedSpawn[] = [];
  const a = new OpenClawAdapter({
    spawner: makeFakeSpawner(
      { exitCode: 0, stdout: "", stderr: "" }, calls,
    ),
  });

  await a.install({
    bridgeContainer: "klio-bridge",
    env: { KLIO_PROFILE: "work" },
  });

  const payload = JSON.parse(calls[0].args[3]);
  assert.deepEqual(payload.env, { KLIO_PROFILE: "work" });
});

test("uninstall via CLI: spawner called with `mcp unset klio`", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".openclaw"));
  const calls: RecordedSpawn[] = [];
  const a = new OpenClawAdapter({
    spawner: makeFakeSpawner(
      { exitCode: 0, stdout: "", stderr: "" }, calls,
    ),
  });

  await a.uninstall();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["mcp", "unset", "klio"]);
});
