// `klio uninstall` on a machine with no Docker.
//
// Live on a cloud machine, uninstall died on its FIRST step — "Stop
// containers and remove volumes" — with `✗ docker compose not found —
// install Docker Desktop`. `runSteps` (ui.ts) rethrows on a
// non-optional step, so nothing after it ran: no adapter config was
// restored, the proxy was never stopped, and ANTHROPIC_BASE_URL was
// left pointing at a proxy still holding the user's API key. The
// command whose entire job is "take Klio off this machine" left the
// most invasive thing it had installed running.
//
// `ensure`, `doctor`, `down` and `uninit` all already branch on the
// same signal (cloud init writes ~/.klio/config.json, local init never
// does). These tests hold `uninstall` to the same contract, and to the
// ordering rule that falls out of it: whatever else fails, the wiring
// comes out and the proxy stops BEFORE anything that needs Docker.
//
// EVERY collaborator is injected. `uninstall` is a destructive command
// that rewrites the developer's own ~/.claude and ~/.codex when its
// real adapters run — that is not a hypothetical, it happened while
// this file was being written — so the guard at the bottom re-checks
// those files and fails if any test here touched them.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { uninstall } from "../src/commands/down.js";
import type { Adapter } from "../src/adapters/types.js";
import type { WireProxyResult } from "../src/proxy/wiring.js";

// `~/.claude.json` is deliberately NOT in this list: Claude Code
// rewrites it continuously as part of normal operation (session state,
// not adapter config), so snapshotting it produces a spurious "written
// by the test suite" failure whenever an unrelated Claude Code session
// happens to touch it mid-run. `~/.claude/settings.json` and
// `~/.codex/config.toml` are the files `uninstall`'s real adapters
// actually write, and they are stable otherwise.
const REAL_AGENT_CONFIGS = [
  join(homedir(), ".claude", "settings.json"),
  join(homedir(), ".codex", "config.toml"),
];
const REAL_AGENT_CONFIGS_BEFORE = snapshotAgentConfigs();

function snapshotAgentConfigs(): Record<string, string | null> {
  const snapshot: Record<string, string | null> = {};
  for (const path of REAL_AGENT_CONFIGS) {
    snapshot[path] = existsSync(path) ? readFileSync(path, "utf8") : null;
  }
  return snapshot;
}

function fakeAdapter(name: string, onUninstall: () => void): Adapter {
  return {
    name: () => name,
    installed: () => true,
    install: async () => {},
    uninstall: async () => onUninstall(),
  } as unknown as Adapter;
}

function okWiring(): WireProxyResult {
  return { skipped: [], errors: [] };
}

function noSupervisor() {
  return Promise.resolve({
    kind: "launchd" as const,
    installed: false,
    paths: [],
    detail: "nothing to remove",
  });
}

const CLOUD = { apiKey: "k", agentId: "a", baseUrl: "https://b" };

test("cloud: uninstall never reaches for Docker, and does stop the proxy", async () => {
  const done: string[] = [];
  const lines: string[] = [];
  await uninstall({
    log: (l) => lines.push(l),
    readCloudConfigFn: () => CLOUD,
    unwireProxyFn: () => {
      done.push("unwire");
      return okWiring();
    },
    uninstallSupervisorFn: async () => {
      done.push("supervisor");
      return { kind: "launchd", installed: false, paths: [], detail: "removed 1 unit file(s)" };
    },
    stopProxyFn: async () => {
      done.push("stop-proxy");
      return { stopped: true, wasRunning: true, detail: "stopped the proxy (pid 42)" };
    },
    resolveComposeBinFn: async () => {
      throw new Error("docker compose not found — install Docker Desktop");
    },
    composeDownFn: (async () => {
      throw new Error("compose must never run on a cloud machine");
    }) as never,
    adaptersFn: () => [fakeAdapter("Claude Code", () => done.push("adapter"))],
  });

  assert.deepEqual(done, ["unwire", "supervisor", "stop-proxy", "adapter"]);
  assert.match(lines.join("\n"), /stopped the proxy/i);
});

test("local: uninstall still removes the containers and volumes", async () => {
  const done: string[] = [];
  let removedVolumes = false;
  await uninstall({
    log: () => {},
    readCloudConfigFn: () => null,
    unwireProxyFn: () => okWiring(),
    uninstallSupervisorFn: noSupervisor,
    stopProxyFn: async () => {
      done.push("stop-proxy");
      return { stopped: false, wasRunning: false, detail: "not running" };
    },
    resolveComposeBinFn: (async () => ({ cmd: "docker", prefix: ["compose"] })) as never,
    composeDownFn: (async (_bin: unknown, _dir: string, volumes: boolean) => {
      removedVolumes = volumes;
      done.push("compose-down");
    }) as never,
    adaptersFn: () => [fakeAdapter("Claude Code", () => done.push("adapter"))],
  });

  assert.equal(removedVolumes, true, "uninstall is the command that deletes data");
  assert.deepEqual(
    done,
    ["adapter", "compose-down"],
    "the container step is last, and the host-process stop does not run in local mode",
  );
});

test("a Docker failure in local mode still leaves the configs restored", async () => {
  const done: string[] = [];
  let threw = false;
  try {
    await uninstall({
      log: () => {},
      readCloudConfigFn: () => null,
      unwireProxyFn: () => {
        done.push("unwire");
        return okWiring();
      },
      uninstallSupervisorFn: async () => {
        done.push("supervisor");
        return { kind: "launchd", installed: false, paths: [], detail: "nothing to remove" };
      },
      resolveComposeBinFn: async () => {
        throw new Error("docker compose not found — install Docker Desktop");
      },
      adaptersFn: () => [fakeAdapter("Claude Code", () => done.push("adapter"))],
    });
  } catch (err) {
    threw = true;
    assert.match(String(err), /docker compose not found/i);
  }

  // Failing to delete the volumes is a real failure and must surface…
  assert.equal(threw, true, "a Docker failure in local mode is still an error");
  // …but only AFTER everything that does not need Docker has happened.
  assert.deepEqual(done, ["unwire", "supervisor", "adapter"]);
});

test("an adapter that throws does not stop the rest of the uninstall", async () => {
  const done: string[] = [];
  await uninstall({
    log: () => {},
    readCloudConfigFn: () => CLOUD,
    unwireProxyFn: () => okWiring(),
    uninstallSupervisorFn: noSupervisor,
    stopProxyFn: async () => ({ stopped: true, wasRunning: true, detail: "stopped" }),
    adaptersFn: () => [
      fakeAdapter("Broken", () => {
        throw new Error("backup file is unreadable");
      }),
      fakeAdapter("Cursor", () => done.push("cursor")),
    ],
  });
  assert.deepEqual(done, ["cursor"]);
});

test("a proxy that will not stop is reported, not swallowed", async () => {
  const lines: string[] = [];
  await uninstall({
    log: (l) => lines.push(l),
    readCloudConfigFn: () => CLOUD,
    unwireProxyFn: () => okWiring(),
    uninstallSupervisorFn: noSupervisor,
    stopProxyFn: async () => ({
      stopped: false,
      wasRunning: true,
      detail: "something is answering on the proxy port, but it is not a Klio proxy",
    }),
    adaptersFn: () => [],
  });
  assert.match(lines.join("\n"), /not a Klio proxy/i);
});

test("the supervisor comes out, or it would revive the proxy a minute later", async () => {
  let uninstalled = false;
  await uninstall({
    log: () => {},
    readCloudConfigFn: () => CLOUD,
    unwireProxyFn: () => okWiring(),
    uninstallSupervisorFn: async () => {
      uninstalled = true;
      return { kind: "launchd", installed: false, paths: [], detail: "removed 1 unit file(s)" };
    },
    stopProxyFn: async () => ({ stopped: true, wasRunning: true, detail: "stopped" }),
    adaptersFn: () => [],
  });
  assert.equal(uninstalled, true);
});

// ---------------------------------------------------------------------
// Last test in the file, deliberately.
// ---------------------------------------------------------------------

test("no test in this file rewrote the developer's real agent configs", () => {
  const after = snapshotAgentConfigs();
  for (const path of REAL_AGENT_CONFIGS) {
    assert.equal(
      after[path],
      REAL_AGENT_CONFIGS_BEFORE[path],
      `${path} was rewritten by the test suite — an uninstall test ran the REAL ` +
        `adapters, which restore this file from a Klio backup`,
    );
  }
});
