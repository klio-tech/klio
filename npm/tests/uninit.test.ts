// `klio uninit` — the escape hatch.
//
// The bug these cover: uninit unwired the agents and then
// UNCONDITIONALLY ran `docker compose stop proxy`. On the cloud path
// there is no Docker and no container — the proxy is a detached host
// process — so the command threw, printed a container error, and left
// the proxy listening on 8787 until reboot, directly contradicting
// init's own promise ("Turn it off any time with `klio uninit`").
//
// Worse in combination: `startProxy` reads the cloud config exactly once
// and the recaller closes over the key, so a survivor of the previous
// init keeps authenticating with a key the user has since rotated —
// and fail-open turns that into "no injection, ever", silently.

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { uninit } from "../src/commands/uninit.js";
import { pidFilePath } from "../src/proxy/processSupervisor.js";

const CLOUD_CONFIG = { apiKey: "ag_live_test", agentId: "a", baseUrl: "https://brain.test" };

/** A temp HOME with settings files uninit can safely rewrite. */
function scratchHome(): { home: string; claudeSettings: string; codexConfig: string; statePath: string } {
  const home = mkdtempSync(join(tmpdir(), "klio-uninit-"));
  const claudeSettings = join(home, ".claude", "settings.json");
  mkdirSync(dirname(claudeSettings), { recursive: true });
  writeFileSync(claudeSettings, "{}", "utf8");
  return {
    home,
    claudeSettings,
    codexConfig: join(home, ".codex", "config.toml"),
    statePath: join(home, ".klio", "proxy-state.json"),
  };
}

test("uninit stops the cloud proxy process, and never reaches for Docker", async () => {
  const scratch = scratchHome();
  let stopCalls = 0;
  let composeResolved = false;
  const lines: string[] = [];
  try {
    const code = await uninit({
      log: (l) => lines.push(l),
      claudeSettings: scratch.claudeSettings,
      codexConfig: scratch.codexConfig,
      statePath: scratch.statePath,
      home: scratch.home,
      readCloudConfigFn: () => CLOUD_CONFIG,
      uninstallSupervisorFn: async () => ({ kind: "launchd", installed: false, paths: [], detail: "nothing to remove" }),
      stopProxyFn: async () => {
        stopCalls++;
        return { stopped: true, wasRunning: true, detail: "stopped the proxy (pid 4242)" };
      },
      resolveComposeBinFn: async () => {
        composeResolved = true;
        throw new Error("Is Docker running?");
      },
    } as never);

    assert.equal(stopCalls, 1, "the cloud proxy must actually be stopped");
    assert.equal(composeResolved, false, "a Docker-free machine must never be asked for docker compose");
    assert.equal(code, 0);
    const out = lines.join("\n");
    assert.match(out, /stopped the proxy/);
    assert.doesNotMatch(out, /Docker|container/i);
  } finally {
    rmSync(scratch.home, { recursive: true, force: true });
  }
});

test("uninit removes a stale pid file left behind by an older install", async () => {
  const scratch = scratchHome();
  try {
    const pidPath = pidFilePath(scratch.home);
    mkdirSync(dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, "4242", "utf8");

    await uninit({
      log: () => {},
      claudeSettings: scratch.claudeSettings,
      codexConfig: scratch.codexConfig,
      statePath: scratch.statePath,
      home: scratch.home,
      readCloudConfigFn: () => CLOUD_CONFIG,
      uninstallSupervisorFn: async () => ({ kind: "launchd", installed: false, paths: [], detail: "nothing to remove" }),
      stopProxyFn: async () => ({ stopped: true, wasRunning: true, detail: "stopped the proxy (pid 4242)" }),
    } as never);

    assert.equal(existsSync(pidPath), false, "a pid file nothing reads must not be left on disk");
  } finally {
    rmSync(scratch.home, { recursive: true, force: true });
  }
});

test("uninit on the local (Docker) path still stops the container", async () => {
  const scratch = scratchHome();
  let stopServiceCalls = 0;
  let stopProxyCalls = 0;
  const lines: string[] = [];
  try {
    const code = await uninit({
      log: (l) => lines.push(l),
      claudeSettings: scratch.claudeSettings,
      codexConfig: scratch.codexConfig,
      statePath: scratch.statePath,
      home: scratch.home,
      readCloudConfigFn: () => null,
      uninstallSupervisorFn: async () => ({ kind: "launchd", installed: false, paths: [], detail: "nothing to remove" }),
      stopProxyFn: async () => {
        stopProxyCalls++;
        return { stopped: false, wasRunning: false, detail: "not running" };
      },
      resolveComposeBinFn: async () => ({ cmd: "docker", prefix: ["compose"] }),
      stopServiceFn: async () => {
        stopServiceCalls++;
      },
    } as never);

    assert.equal(stopServiceCalls, 1, "local mode must still stop the container");
    assert.equal(stopProxyCalls, 0, "local mode must not signal a host pid — the proxy is in a container");
    assert.equal(code, 0);
    assert.match(lines.join("\n"), /container stopped/i);
  } finally {
    rmSync(scratch.home, { recursive: true, force: true });
  }
});

test("uninit reports a proxy it could not stop rather than claiming success", async () => {
  const scratch = scratchHome();
  const lines: string[] = [];
  try {
    await uninit({
      log: (l) => lines.push(l),
      claudeSettings: scratch.claudeSettings,
      codexConfig: scratch.codexConfig,
      statePath: scratch.statePath,
      home: scratch.home,
      readCloudConfigFn: () => CLOUD_CONFIG,
      uninstallSupervisorFn: async () => ({ kind: "launchd", installed: false, paths: [], detail: "nothing to remove" }),
      stopProxyFn: async () => ({
        stopped: false,
        wasRunning: true,
        detail: "could not signal the proxy (pid 4242): EPERM",
      }),
    } as never);

    const out = lines.join("\n");
    assert.match(out, /could not signal the proxy/);
    assert.match(out, /^\s*!/m, "an unstopped proxy must be flagged, not reported with a tick");
  } finally {
    rmSync(scratch.home, { recursive: true, force: true });
  }
});
