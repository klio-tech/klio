# OpenCode + OpenClaw Adapters Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `OpenCodeAdapter` and `OpenClawAdapter` to the npm package so `klio init` auto-detects + wires klio's MCP server into OpenCode (`~/.config/opencode/opencode.json`) and OpenClaw (via `openclaw mcp set` CLI with file-write fallback). Ship as `0.4.1`.

**Architecture:** Two new TypeScript adapters mirroring our existing five (Claude Code, Claude Desktop, Cursor, Codex, …). Both implement the existing `Adapter` interface from `npm/src/adapters/types.ts`. OpenCode uses direct JSON file writes (Cursor/Claude Desktop pattern); OpenClaw uses CLI shell-out (Claude Code pattern) with a JSON file-write fallback when the CLI is missing.

**Tech Stack:** Node 20+, TypeScript strict, `node:test`, `node:child_process` (for OpenClaw CLI shell-out), zero new runtime dependencies.

**Source design:** `docs/plans/2026-05-04-opencode-openclaw-adapters-design.md`

**Branch + push policy:** Work on `feat/opencode-openclaw-adapters`. **Do not push to GitHub** — commit locally only until the user approves. Mirrors the 0.3.x / 0.4.0 policy.

---

## Section A — OpenCode adapter

### Task A1: `OpenCodeAdapter` + tests

**Files:**
- Create: `npm/src/adapters/openCode.ts`
- Create: `npm/tests/openCode.test.ts`

OpenCode's config lives at `~/.config/opencode/opencode.json` (XDG-aware: respect `XDG_CONFIG_HOME` if set). Schema:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "klio": {
      "type": "local",
      "command": ["docker", "exec", "-i", "klio-bridge", "klio-mcp"],
      "enabled": true
    }
  }
}
```

**Important shape diff vs. Claude/Cursor:** `command` is a single ARRAY (process + args together), not separate `command` string + `args` array.

#### Step 1: Write failing tests

Create `npm/tests/openCode.test.ts`. Use the same hermetic pattern as `npm/tests/claudeDesktop.test.ts` — redirect `HOME`, `USERPROFILE`, `APPDATA`, `XDG_CONFIG_HOME` to a fresh `tmpdir` per test:

```typescript
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
```

#### Step 2: Run tests, expect FAIL

```bash
cd /Users/thakurg/Me/klio/npm && npm test 2>&1 | tail -10
```
Expected: tests fail with "Cannot find module '../src/adapters/openCode.js'".

#### Step 3: Implement adapter

Create `npm/src/adapters/openCode.ts`:

```typescript
// OpenCode (SST's open-source AI coding agent) adapter.
//
// Config lives at:
//   $XDG_CONFIG_HOME/opencode/opencode.json   (if XDG_CONFIG_HOME set)
//   ~/.config/opencode/opencode.json          (POSIX default)
//
// Schema (per https://opencode.ai/docs/mcp-servers):
//
//   {
//     "$schema": "https://opencode.ai/config.json",
//     "mcp": {
//       "klio": {
//         "type": "local",
//         "command": ["docker", "exec", "-i", "klio-bridge", "klio-mcp"],
//         "enabled": true
//       }
//     }
//   }
//
// Note the shape diff vs. Claude/Cursor/Codex: `command` is a SINGLE
// ARRAY (process + args together), not separate `command` string +
// `args` array. Tests pin this exactly.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Adapter, AdapterConfig } from "./types.js";
import {
  backupFile,
  readJson,
  restoreFromBackup,
  writeJson,
} from "./fileutil.js";

export class OpenCodeAdapter implements Adapter {
  name(): string {
    return "opencode";
  }

  private configDir(): string {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg) return join(xdg, "opencode");
    return join(homedir(), ".config", "opencode");
  }

  private configPath(): string {
    return join(this.configDir(), "opencode.json");
  }

  installed(): boolean {
    return existsSync(this.configDir());
  }

  async install(cfg: AdapterConfig): Promise<void> {
    const path = this.configPath();
    const settings = readJson(path);
    backupFile(path);

    const mcp =
      (settings["mcp"] as Record<string, unknown> | undefined) ?? {};

    const entry: Record<string, unknown> = {
      type: "local",
      command: ["docker", "exec", "-i", cfg.bridgeContainer, "klio-mcp"],
      enabled: true,
    };
    if (Object.keys(cfg.env).length > 0) {
      // OpenCode's docs use `environment`, not `env`, for the env-var
      // map on local servers.
      entry["environment"] = cfg.env;
    }
    mcp["klio"] = entry;

    settings["mcp"] = mcp;
    // Preserve / add the schema reference if absent.
    if (!settings["$schema"]) {
      settings["$schema"] = "https://opencode.ai/config.json";
    }

    writeJson(path, settings);
  }

  async uninstall(): Promise<void> {
    const path = this.configPath();
    if (!existsSync(path)) return;
    try {
      restoreFromBackup(path);
      return;
    } catch {
      // No backup — fall through to in-place strip.
    }
    const settings = readJson(path);
    const mcp = settings["mcp"];
    if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
      const m = mcp as Record<string, unknown>;
      delete m["klio"];
      if (Object.keys(m).length === 0) delete settings["mcp"];
      else settings["mcp"] = m;
    }
    writeJson(path, settings);
  }
}
```

#### Step 4: Run tests, expect PASS

```bash
cd /Users/thakurg/Me/klio/npm && npm test 2>&1 | tail -10
```
Expected: all 10 OpenCode tests pass + existing 168 unchanged.

#### Step 5: Commit

```bash
cd /Users/thakurg/Me/klio
git add npm/src/adapters/openCode.ts npm/tests/openCode.test.ts
git commit -m "feat(npm): OpenCode adapter (~/.config/opencode/opencode.json)"
```

---

## Section B — OpenClaw adapter (CLI + file-write fallback)

OpenClaw's MCP config is normally written via its CLI:

```bash
openclaw mcp set klio '{"command":"docker","args":["exec","-i","klio-bridge","klio-mcp"],"env":{}}'
```

The CLI manages `~/.openclaw/config.json` internally. We use the CLI when present (insulates us against schema changes); fall back to direct file write when the CLI is missing but the directory exists.

This is structurally bigger than OpenCode because we need:
- A `Spawner` injection seam for hermetic tests (so we don't shell out to a real `openclaw` binary)
- Two install paths (CLI primary, file-write fallback)
- Detection that handles `~/.openclaw/` exists, OR `openclaw` on PATH, OR both

Three commits. Each TDD-shaped.

### Task B1: `Spawner` abstraction

A small wrapper that lets tests inject a fake child_process. Used by OpenClaw and reusable for any future CLI-based adapter.

**Files:**
- Create: `npm/src/adapters/spawner.ts`
- Create: `npm/tests/spawner.test.ts`

#### Step 1: Tests

```typescript
// npm/tests/spawner.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runProcess } from "../src/adapters/spawner.js";

test("runProcess returns stdout + exitCode 0 on success", async () => {
  const r = await runProcess("/bin/echo", ["hello"]);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /hello/);
});

test("runProcess returns non-zero exitCode on failure", async () => {
  const r = await runProcess("/bin/sh", ["-c", "exit 7"]);
  assert.equal(r.exitCode, 7);
});

test("runProcess rejects with ENOENT when binary absent", async () => {
  await assert.rejects(
    () => runProcess("/no/such/binary/anywhere", []),
    /ENOENT|spawn/,
  );
});

test("runProcess captures stderr separately", async () => {
  const r = await runProcess("/bin/sh", ["-c", "echo err >&2"]);
  assert.equal(r.exitCode, 0);
  assert.match(r.stderr, /err/);
});
```

#### Step 2: Run tests, expect FAIL.

#### Step 3: Implement

```typescript
// npm/src/adapters/spawner.ts
//
// Tiny wrapper over node:child_process.spawn that resolves to a
// {stdout, stderr, exitCode} record instead of dealing with raw
// streams. Adapters that shell out to a CLI (Claude Code,
// OpenClaw) use this so their tests can inject a fake spawner
// without needing the real binary on PATH.

import { spawn, type SpawnOptions } from "node:child_process";

export type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type Spawner = (
  cmd: string,
  args: string[],
  opts?: SpawnOptions,
) => Promise<ProcessResult>;

export const runProcess: Spawner = (cmd, args, opts) =>
  new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...opts,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
```

#### Step 4: Run tests, expect PASS.

#### Step 5: Commit

```bash
cd /Users/thakurg/Me/klio
git add npm/src/adapters/spawner.ts npm/tests/spawner.test.ts
git commit -m "feat(npm): runProcess spawner helper for CLI-based adapters"
```

### Task B2: `OpenClawAdapter` (CLI path)

**Files:**
- Create: `npm/src/adapters/openClaw.ts`
- Create: `npm/tests/openClaw.test.ts`

The CLI path is the happy path. File-write fallback is Task B3.

#### Step 1: Tests for the CLI path

```typescript
// npm/tests/openClaw.test.ts
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
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = prev;
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

test("not installed when ~/.openclaw absent and CLI absent", (t) => {
  withFakeHome(t);
  const a = new OpenClawAdapter({
    spawner: async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });
  assert.equal(a.installed(), false);
});

test("installed when ~/.openclaw exists (even if no CLI)", (t) => {
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
  withFakeHome(t);
  mkdirSync(join(process.env.HOME!, ".openclaw"));
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
  withFakeHome(t);
  mkdirSync(join(process.env.HOME!, ".openclaw"));
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
```

#### Step 2: Run tests, expect FAIL.

#### Step 3: Implement (CLI path only — file-write fallback in Task B3)

```typescript
// npm/src/adapters/openClaw.ts
//
// OpenClaw (https://openclaw.ai) adapter.
//
// OpenClaw exposes a CLI for MCP server registration:
//
//   openclaw mcp set <name> '<json>'      # add or update
//   openclaw mcp unset <name>             # remove
//
// We use the CLI as the primary write path. The CLI manages
// ~/.openclaw/config.json internally; we don't touch the file
// directly when the CLI is available (insulates us against
// schema changes upstream). A file-write fallback exists for
// users whose CLI is missing — see filewriteFallback() below.
//
// Detection: `~/.openclaw/` directory exists OR `openclaw` is
// on PATH (resolved via spawning a probe).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Adapter, AdapterConfig } from "./types.js";
import { runProcess, type Spawner } from "./spawner.js";

export type OpenClawAdapterOptions = {
  /** Inject a fake spawner for tests. Defaults to the real one. */
  spawner?: Spawner;
};

export class OpenClawAdapter implements Adapter {
  private readonly spawner: Spawner;

  constructor(opts: OpenClawAdapterOptions = {}) {
    this.spawner = opts.spawner ?? runProcess;
  }

  name(): string {
    return "openclaw";
  }

  private configDir(): string {
    return join(homedir(), ".openclaw");
  }

  installed(): boolean {
    // Cheap check: directory exists. We don't probe the CLI in
    // installed() because that would require an async call (and
    // adapters' installed() is sync by interface contract).
    return existsSync(this.configDir());
  }

  async install(cfg: AdapterConfig): Promise<void> {
    const payload = {
      command: "docker",
      args: ["exec", "-i", cfg.bridgeContainer, "klio-mcp"],
      env: cfg.env ?? {},
    };
    const result = await this.spawner("openclaw", [
      "mcp",
      "set",
      "klio",
      JSON.stringify(payload),
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `openclaw mcp set failed (exit ${result.exitCode}): ` +
          (result.stderr.trim() || result.stdout.trim()),
      );
    }
  }

  async uninstall(): Promise<void> {
    const result = await this.spawner("openclaw", [
      "mcp",
      "unset",
      "klio",
    ]);
    if (result.exitCode !== 0) {
      // Best-effort uninstall — don't throw on a missing entry.
      // Surface the message for debugging only.
      // (The init flow already wraps adapter uninstalls in try/catch.)
    }
  }
}
```

#### Step 4: Run tests, expect PASS (the 6 tests so far).

#### Step 5: Commit

```bash
cd /Users/thakurg/Me/klio
git add npm/src/adapters/openClaw.ts npm/tests/openClaw.test.ts
git commit -m "feat(npm): OpenClaw adapter via `openclaw mcp set` CLI"
```

### Task B3: File-write fallback for OpenClaw

When `openclaw` CLI isn't on PATH, fall back to writing
`~/.openclaw/config.json` directly with the same JSON shape OpenClaw
itself uses internally.

**Files:**
- Modify: `npm/src/adapters/openClaw.ts` (extend `install()` to catch ENOENT and fall back)
- Modify: `npm/tests/openClaw.test.ts` (add fallback tests)

#### Step 1: Add fallback tests

Append these tests to `npm/tests/openClaw.test.ts`:

```typescript
test("install falls back to file write when CLI is missing (ENOENT)", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".openclaw"));

  let spawnerCallCount = 0;
  const a = new OpenClawAdapter({
    spawner: async () => {
      spawnerCallCount++;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });

  await a.install({ bridgeContainer: "klio-bridge", env: {} });

  // Spawner attempted once, then fallback wrote the file directly.
  assert.equal(spawnerCallCount, 1);
  const path = join(home, ".openclaw", "config.json");
  assert.equal(existsSync(path), true);
  const body = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(body.mcp.servers.klio, {
    command: "docker",
    args: ["exec", "-i", "klio-bridge", "klio-mcp"],
    env: {},
  });
});

test("install fallback preserves peer mcp.servers entries", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".openclaw"));
  const path = join(home, ".openclaw", "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      mcp: {
        servers: { other: { command: "/o", args: [], env: {} } },
      },
      otherKey: "preserve me",
    }),
  );

  const a = new OpenClawAdapter({
    spawner: async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });

  await a.install({ bridgeContainer: "klio-bridge", env: {} });

  const body = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(body.mcp.servers.other, {
    command: "/o", args: [], env: {},
  });
  assert.equal(body.otherKey, "preserve me");
  assert.ok(body.mcp.servers.klio);
});

test("install fallback is idempotent", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".openclaw"));
  const a = new OpenClawAdapter({
    spawner: async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });

  await a.install({ bridgeContainer: "klio-bridge", env: { K: "V" } });
  const first = readFileSync(
    join(home, ".openclaw", "config.json"), "utf8",
  );
  await a.install({ bridgeContainer: "klio-bridge", env: { K: "V" } });
  const second = readFileSync(
    join(home, ".openclaw", "config.json"), "utf8",
  );
  assert.equal(first, second);
});

test("install rethrows non-ENOENT spawner errors (e.g. CLI present but exited non-zero)", async (t) => {
  withFakeHome(t);
  mkdirSync(join(process.env.HOME!, ".openclaw"));
  const a = new OpenClawAdapter({
    spawner: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "boom",
    }),
  });
  await assert.rejects(
    () => a.install({ bridgeContainer: "klio-bridge", env: {} }),
    /openclaw mcp set failed/,
  );
});
```

#### Step 2: Run tests, expect FAIL on the new ones.

#### Step 3: Extend install() with the fallback

Edit `npm/src/adapters/openClaw.ts`. Replace the existing `install()` method with a CLI-first, file-write-fallback version:

```typescript
  async install(cfg: AdapterConfig): Promise<void> {
    const payload = {
      command: "docker",
      args: ["exec", "-i", cfg.bridgeContainer, "klio-mcp"],
      env: cfg.env ?? {},
    };
    try {
      const result = await this.spawner("openclaw", [
        "mcp", "set", "klio",
        JSON.stringify(payload),
      ]);
      if (result.exitCode !== 0) {
        throw new Error(
          `openclaw mcp set failed (exit ${result.exitCode}): ` +
            (result.stderr.trim() || result.stdout.trim()),
        );
      }
      return;
    } catch (err) {
      // ENOENT means the `openclaw` binary isn't on PATH. Fall
      // back to a direct file write — the user has ~/.openclaw/
      // (we wouldn't be here otherwise; installed() returned
      // true) so they have OpenClaw set up but a non-standard
      // CLI install. Write to the documented config path.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      this.fileWriteFallback(payload);
    }
  }

  /**
   * Last-resort install path: write ~/.openclaw/config.json
   * directly. Mirrors the JSON shape OpenClaw's CLI writes
   * internally (mcp.servers.<name>: {command, args, env}).
   *
   * Idempotent — re-running with identical inputs produces a
   * byte-equal file.
   */
  private fileWriteFallback(payload: {
    command: string;
    args: string[];
    env: Record<string, string>;
  }): void {
    // Deferred imports keep the test setup hermetic — the
    // CLI-path tests don't load fileutil unless they actually
    // hit the fallback.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {
      readJson,
      writeJson,
    } = require("./fileutil.js") as typeof import("./fileutil.js");

    const path = join(this.configDir(), "config.json");
    const settings = readJson(path);
    const mcp = (settings["mcp"] as Record<string, unknown> | undefined) ?? {};
    const servers =
      (mcp["servers"] as Record<string, unknown> | undefined) ?? {};
    servers["klio"] = payload;
    mcp["servers"] = servers;
    settings["mcp"] = mcp;
    writeJson(path, settings);
  }
```

(Note: the inline `require` for fileutil mid-method is intentional — keeps the import out of the hot CLI path. If the project linter rejects it, hoist to a top-level `import` and rely on tree-shaking.)

#### Step 4: Run tests, expect PASS (all 10 OpenClaw tests + the 4 new fallback tests).

#### Step 5: Commit

```bash
cd /Users/thakurg/Me/klio
git add npm/src/adapters/openClaw.ts npm/tests/openClaw.test.ts
git commit -m "feat(npm): OpenClaw file-write fallback when CLI absent"
```

---

## Section C — Wire into the adapter list

### Task C1: Register both adapters + update narrate text

**Files:**
- Modify: `npm/src/adapters/types.ts`
- Modify: `npm/src/commands/init.ts`

#### Step 1: Update `allAdapters()`

Edit `npm/src/adapters/types.ts`. Add the two imports and extend the array:

```typescript
import { ClaudeCodeAdapter } from "./claudeCode.js";
import { ClaudeDesktopAdapter } from "./claudeDesktop.js";
import { CodexAdapter } from "./codex.js";
import { CursorAdapter } from "./cursor.js";
import { OpenClawAdapter } from "./openClaw.js";    // NEW
import { OpenCodeAdapter } from "./openCode.js";    // NEW

// ... (existing AdapterConfig type, etc.)

export function allAdapters(): Adapter[] {
  return [
    new ClaudeCodeAdapter(),
    new ClaudeDesktopAdapter(),
    new CursorAdapter(),
    new CodexAdapter(),
    new OpenCodeAdapter(),    // NEW
    new OpenClawAdapter(),    // NEW
  ];
}
```

#### Step 2: Update narrate text in init.ts

Find the narrate string in `npm/src/commands/init.ts` (currently line ~608):

```typescript
"Klio supports Claude Code, Claude Desktop (Chat + Cowork), Cursor, and Codex — we patch each one's config to add the MCP server.",
```

Replace with:

```typescript
"Klio supports Claude Code, Claude Desktop (Chat + Cowork), Cursor, Codex, OpenCode, and OpenClaw — we patch each one's config to add the MCP server.",
```

#### Step 3: Run tests, expect PASS

```bash
cd /Users/thakurg/Me/klio/npm && npm test 2>&1 | tail -10
```
Expected: all tests still pass (the new adapters' tests + existing adapters' tests + everything else).

#### Step 4: Run `npm run build`

```bash
cd /Users/thakurg/Me/klio/npm && npm run build 2>&1 | tail -3
```
Expected: clean tsc output.

#### Step 5: Commit

```bash
cd /Users/thakurg/Me/klio
git add npm/src/adapters/types.ts npm/src/commands/init.ts
git commit -m "feat(npm): register OpenCode + OpenClaw in adapter list"
```

---

## Section D — Ship 0.4.1

### Task D1: Bump version + push (gated on user approval)

**Files:**
- Modify: `npm/package.json`
- Modify: `npm/package-lock.json`

#### Step 1: Bump

```bash
cd /Users/thakurg/Me/klio/npm
node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json','utf8')); p.version='0.4.1'; fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n')"
npm install --package-lock-only --no-audit --no-fund
```

#### Step 2: Verify tests + build clean

```bash
npm test 2>&1 | tail -5
npm run build 2>&1 | tail -3
```
Expected: all green.

#### Step 3: Commit

```bash
cd /Users/thakurg/Me/klio
git add npm/package.json npm/package-lock.json
git commit -m "chore(npm): release 0.4.1 — OpenCode + OpenClaw adapters"
```

#### Step 4: Push (only after user approval)

When user explicitly approves:

```bash
cd /Users/thakurg/Me/klio
# Push the feature branch first
git push -u origin feat/opencode-openclaw-adapters
# Then merge to main
git checkout main
git merge --ff-only feat/opencode-openclaw-adapters
git push
```

CI publishes:
- `@klio-tech/klio@0.4.1` to npm
- Image workflow re-tags `klio-engine`/`klio-bridge`/`klio-trust-app`/`klio-landing` at `:0.4.1` (byte-identical to 0.4.0 since no source changed there — acceptable noise)

---

## Closing notes

- **Tests:** every adapter has its own `*.test.ts` running via `node:test`. Run all with `cd npm && npm test`. Expect ~190 tests after this section (was 168 + ~22 new).
- **Coverage:** 80%+ on new modules, hermetic via env-var redirection (OpenCode) + injected `Spawner` (OpenClaw).
- **Rollback path:** if `0.4.1` breaks, npm-install pinning to `0.4.0` is fine; the engine + bridge images are unchanged.
- **Skill follow-up:** for execution, use `superpowers:subagent-driven-development` (same-session, fresh subagent per task) or `superpowers:executing-plans` (separate session, batched).
