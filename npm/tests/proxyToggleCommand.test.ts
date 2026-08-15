// `klio proxy capture <on|off>` / `klio proxy inject <on|off>` — the
// way a user turns a half off WITHOUT hand-editing JSON.
//
// The env var alone was never a real control (see proxy/toggles.ts):
// the supervised proxy never sees the user's shell. Telling users to
// edit ~/.klio/config.json by hand instead is not a control either —
// that file holds their API key. So the switch needs a command, and the
// command has to be honest about three things: whether the setting was
// recorded, whether the RUNNING proxy picked it up, and whether an env
// var in the caller's own shell is about to override it anyway.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runProxyCommand } from "../src/commands/proxy.js";
import { readPersistedToggles } from "../src/proxy/toggles.js";

function tempConfig(body: unknown = { apiKey: "k", agentId: "a", baseUrl: "https://b" }): {
  home: string;
  path: string;
} {
  const home = mkdtempSync(join(tmpdir(), "klio-toggle-cmd-"));
  mkdirSync(join(home, ".klio"), { recursive: true, mode: 0o700 });
  const path = join(home, ".klio", "config.json");
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  return { home, path };
}

const NODE_PROXY = {
  alive: true,
  detail: "alive (inject+capture)",
  health: {
    status: "ok" as const,
    mode: "inject+capture",
    runtime: "node" as const,
    pid: 4242,
    config_fingerprint: "f".repeat(16),
  },
};

test("`proxy capture off` persists the opt-out", async () => {
  const { home, path } = tempConfig();
  try {
    const lines: string[] = [];
    const code = await runProxyCommand({
      args: ["capture", "off"],
      log: (l) => lines.push(l),
      env: {},
      configPathImpl: () => path,
      probeProxyImpl: async () => ({ alive: false, detail: "no response" }),
    });
    assert.equal(code, 0);
    assert.deepEqual(readPersistedToggles(path), { capture: false });
    assert.match(lines.join("\n"), /capture is now off/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("`proxy inject on` clears an earlier opt-out and leaves capture alone", async () => {
  const { home, path } = tempConfig({
    apiKey: "k",
    proxy: { inject: false, capture: false },
  });
  try {
    const code = await runProxyCommand({
      args: ["inject", "on"],
      log: () => {},
      env: {},
      configPathImpl: () => path,
      probeProxyImpl: async () => ({ alive: false, detail: "no response" }),
    });
    assert.equal(code, 0);
    assert.deepEqual(readPersistedToggles(path), { inject: true, capture: false });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the API key survives being written through the toggle command", async () => {
  const { home, path } = tempConfig({ apiKey: "secret", agentId: "a", baseUrl: "https://b" });
  try {
    await runProxyCommand({
      args: ["capture", "off"],
      log: () => {},
      env: {},
      configPathImpl: () => path,
      probeProxyImpl: async () => ({ alive: false, detail: "no response" }),
    });
    const raw = JSON.parse(
      (await import("node:fs")).readFileSync(path, "utf8"),
    ) as Record<string, unknown>;
    assert.equal(raw.apiKey, "secret");
    assert.equal(raw.agentId, "a");
    assert.equal(raw.baseUrl, "https://b");
    assert.deepEqual(raw.proxy, { capture: false }, "…and the toggle was actually recorded");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("with no argument it reports the current state and its source, changing nothing", async () => {
  const { home, path } = tempConfig({ apiKey: "k", proxy: { capture: false } });
  try {
    const lines: string[] = [];
    const code = await runProxyCommand({
      args: ["capture"],
      log: (l) => lines.push(l),
      env: {},
      configPathImpl: () => path,
      probeProxyImpl: async () => ({ alive: false, detail: "no response" }),
    });
    assert.equal(code, 0);
    assert.match(lines.join("\n"), /capture: off/i);
    assert.match(lines.join("\n"), /config\.json|saved setting/i);
    assert.deepEqual(readPersistedToggles(path), { capture: false }, "a read must not write");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a value that is neither on nor off is refused rather than guessed at", async () => {
  const { home, path } = tempConfig();
  try {
    const lines: string[] = [];
    const code = await runProxyCommand({
      args: ["capture", "maybe"],
      log: (l) => lines.push(l),
      env: {},
      configPathImpl: () => path,
      probeProxyImpl: async () => ({ alive: false, detail: "no response" }),
    });
    assert.equal(code, 2);
    assert.deepEqual(readPersistedToggles(path), {}, "an unparsed value must not be recorded");
    assert.match(lines.join("\n"), /on\|off/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an env var set in the caller's shell is called out, because it wins", async () => {
  const { home, path } = tempConfig();
  try {
    const lines: string[] = [];
    const code = await runProxyCommand({
      args: ["capture", "off"],
      log: (l) => lines.push(l),
      env: { KLIO_PROXY_CAPTURE: "on" },
      configPathImpl: () => path,
      probeProxyImpl: async () => ({ alive: false, detail: "no response" }),
    });
    assert.equal(code, 0);
    assert.deepEqual(readPersistedToggles(path), { capture: false }, "the setting is still saved");
    assert.match(
      lines.join("\n"),
      /KLIO_PROXY_CAPTURE/,
      "a shell export that overrides the saved setting must be named, not hidden",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// Applying the change to the process that is ALREADY running.
// ---------------------------------------------------------------------

test("a running Klio proxy is restarted so the change takes effect now", async () => {
  const { home, path } = tempConfig();
  try {
    let stopCalls = 0;
    let spawnCalls = 0;
    const lines: string[] = [];
    const code = await runProxyCommand({
      args: ["capture", "off"],
      log: (l) => lines.push(l),
      env: {},
      configPathImpl: () => path,
      probeProxyImpl: async () =>
        stopCalls === 0
          ? NODE_PROXY
          : { ...NODE_PROXY, detail: "alive (inject)", health: { ...NODE_PROXY.health, mode: "inject" } },
      stopProxyImpl: async () => {
        stopCalls++;
        return { stopped: true, wasRunning: true, detail: "stopped the proxy (pid 4242)" };
      },
      spawnProxyImpl: (() => {
        spawnCalls++;
        return 5555;
      }) as never,
      cliPath: "/fake/cli.mjs",
      sleepImpl: async () => {},
    });
    assert.equal(code, 0);
    assert.equal(stopCalls, 1);
    assert.equal(spawnCalls, 1);
    assert.match(lines.join("\n"), /inject/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a proxy that cannot be restarted is reported, and the setting still stands", async () => {
  const { home, path } = tempConfig();
  try {
    const lines: string[] = [];
    const code = await runProxyCommand({
      args: ["capture", "off"],
      log: (l) => lines.push(l),
      env: {},
      configPathImpl: () => path,
      probeProxyImpl: async () => NODE_PROXY,
      stopProxyImpl: async () => ({
        stopped: false,
        wasRunning: true,
        detail: "could not signal the proxy (pid 4242): EPERM",
      }),
      spawnProxyImpl: (() => {
        throw new Error("spawn must not run when the old proxy is still up");
      }) as never,
      cliPath: "/fake/cli.mjs",
      sleepImpl: async () => {},
    });
    // Not a failure of the command's purpose — the opt-out IS recorded
    // and will hold from the next start — but the user must not be left
    // believing their conversations stopped flowing when they have not.
    assert.equal(code, 1);
    assert.deepEqual(readPersistedToggles(path), { capture: false });
    const out = lines.join("\n");
    assert.match(out, /EPERM/);
    assert.match(out, /still (running|sending)|next start/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a foreign listener on the port is never signalled by the toggle command", async () => {
  const { home, path } = tempConfig();
  try {
    const lines: string[] = [];
    const code = await runProxyCommand({
      args: ["capture", "off"],
      log: (l) => lines.push(l),
      env: {},
      configPathImpl: () => path,
      probeProxyImpl: async () => ({
        alive: true,
        responded: true,
        detail: "alive (passthrough)",
        health: { status: "ok" as const, mode: "passthrough", upstreams: {} },
      }),
      stopProxyImpl: (async () => {
        throw new Error("must not try to stop a proxy that is not ours");
      }) as never,
      cliPath: "/fake/cli.mjs",
      sleepImpl: async () => {},
    });
    assert.equal(code, 0);
    assert.deepEqual(readPersistedToggles(path), { capture: false });
    assert.match(lines.join("\n"), /restart/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("`proxy status` says what the saved settings are, not just that it is alive", async () => {
  const { home, path } = tempConfig({ apiKey: "k", proxy: { capture: false } });
  try {
    const lines: string[] = [];
    const code = await runProxyCommand({
      args: ["status"],
      log: (l) => lines.push(l),
      env: {},
      configPathImpl: () => path,
      probeProxyImpl: async () => NODE_PROXY,
    });
    assert.equal(code, 0);
    const out = lines.join("\n");
    assert.match(out, /inject: on/i);
    assert.match(out, /capture: off/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
