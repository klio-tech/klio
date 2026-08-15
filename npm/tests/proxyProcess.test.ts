import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { CloudConfig } from "../src/cloudConfig.js";
import { runProxyCommand } from "../src/commands/proxy.js";
import { pidFilePath, spawnProxy } from "../src/proxy/processSupervisor.js";

// `pidFilePath` outlives the pid FILE: nothing writes it any more (a
// pid on disk was never evidence of anything — see processSupervisor.ts),
// but `klio uninit` still needs the path to delete what an older install
// left behind.
test("pid file path is still resolvable so uninit can clean up after older installs", () => {
  assert.match(pidFilePath("/home/x"), /^\/home\/x\/\.klio\/proxy\.pid$/);
});

test("spawn is detached and unref'd, and writes no pid file", () => {
  let seenArgs: string[] = [];
  let seenOpts: any = null;
  const home = mkdtempSync(join(tmpdir(), "klio-proxy-process-"));
  try {
    const pid = spawnProxy({
      cliPath: "/tmp/cli.js",
      spawnImpl: ((_cmd: string, args: string[], o: any) => {
        seenArgs = args;
        seenOpts = o;
        return { pid: 4242, unref() {}, on() {} } as any;
      }) as any,
    });
    assert.equal(pid, 4242);
    assert.deepEqual(seenArgs, ["/tmp/cli.js", "proxy", "serve"]);
    assert.equal(seenOpts.detached, true);
    assert.equal(existsSync(pidFilePath(home)), false, "the orphan pid write must be gone");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- ensure()'s cloud-mode process strategy ----------------------------
//
// `ensure` must probe first and only revive on failure. On the cloud
// path, revival ALWAYS attempts `spawnProxy` once the probe has
// failed — it is not gated behind a `kill(pid, 0)` liveness check on
// the last recorded pid, because a pid can be recycled by a totally
// unrelated process. Regression coverage for that: "a live but
// unrelated recorded pid does not block revival" below. These tests
// drive `runProxyCommand` end to end with every seam (probe,
// cloud-config read, spawn, startProxy) injected so nothing touches
// the network, a real process, or the real filesystem.

const CLOUD_CONFIG: CloudConfig = {
  apiKey: "ag_live_test",
  agentId: "klio-test-agent",
  baseUrl: "https://brain.test",
};

function alive() {
  return Promise.resolve({ alive: true, detail: "alive (cloud)" });
}
function dead() {
  return Promise.resolve({ alive: false, detail: "no response" });
}

test("ensure: cloud mode spawns when the health probe fails", async () => {
  let spawnCalls = 0;
  const probes = [dead, alive]; // fails once, then succeeds after revive
  let probeCall = 0;

  const code = await runProxyCommand({
    args: ["ensure"],
    log: () => {},
    probeProxyImpl: (() => probes[Math.min(probeCall++, probes.length - 1)]()) as any,
    readCloudConfigImpl: () => CLOUD_CONFIG,
    spawnProxyImpl: (() => {
      spawnCalls++;
      return 4321;
    }) as any,
    cliPath: "/tmp/cli.js",
  });

  assert.equal(spawnCalls, 1);
  assert.equal(code, 0);
});

test("ensure: cloud mode does NOT spawn when the health probe succeeds", async () => {
  let spawnCalls = 0;

  const code = await runProxyCommand({
    args: ["ensure"],
    log: () => {},
    probeProxyImpl: alive as any,
    readCloudConfigImpl: () => CLOUD_CONFIG,
    spawnProxyImpl: (() => {
      spawnCalls++;
      return 4321;
    }) as any,
  });

  assert.equal(spawnCalls, 0);
  assert.equal(code, 0);
});

// Regression for the critical bug the review caught: a recycled pid
// (some unrelated long-lived process happening to reuse the number
// klio recorded) must NOT block revival. Real-world repro was: put an
// unrelated process's pid in ~/.klio/proxy.pid, cloud config present,
// nothing actually listening on the proxy port — `isProxyRunning(pid)`
// returns true because signal 0 reaches the unrelated process, so a
// pid-gated `reviveCloud` returned early without ever spawning, and
// `ensure` reported failure forever on every 60s tick.
//
// This is deliberately NOT driven through a mock seam — the whole bug
// was that the old code fell through to the REAL, unmocked pid-file
// readers (`pidFilePath()` / `homedir()` / `process.kill`) whenever no
// override was injected, which is exactly what a clean test (or a clean
// CI machine) hands it. A test that injects fake pid seams can't
// reproduce that — it would pass against the pre-fix code and the
// post-fix code alike, proving nothing. So this test redirects HOME at a
// temp directory, writes a REAL pid file there naming a REAL,
// currently-alive, definitely-not-our-proxy process (`process.pid` —
// this test's own process), and asserts `spawnProxy` is still called
// once the probe fails. The readers are gone entirely now, and a pid
// file left on disk by an OLDER install is exactly the input that must
// still not change the outcome.
test("ensure: a failed probe always spawns, regardless of what a real pid file on disk says", async () => {
  const tempHome = mkdtempSync(join(tmpdir(), "klio-proxy-realpid-"));
  const originalHome = process.env["HOME"];
  try {
    const pidPath = pidFilePath(tempHome);
    mkdirSync(dirname(pidPath), { recursive: true });
    // `process.pid` is genuinely alive for the duration of this test
    // and is definitely not a klio proxy — exactly the "recycled pid"
    // scenario from the live repro.
    writeFileSync(pidPath, String(process.pid), "utf8");

    process.env["HOME"] = tempHome; // redirects the real, unmocked homedir()

    let spawnCalls = 0;
    const probes = [dead, alive];
    let probeCall = 0;

    const code = await runProxyCommand({
      args: ["ensure"],
      log: () => {},
      probeProxyImpl: (() => probes[Math.min(probeCall++, probes.length - 1)]()) as any,
      readCloudConfigImpl: () => CLOUD_CONFIG,
      spawnProxyImpl: (() => {
        spawnCalls++;
        return 4321;
      }) as any,
    });

    assert.equal(spawnCalls, 1);
    assert.equal(code, 0);
  } finally {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test("ensure: cloud mode reports failure (exit 1) when the proxy never comes up", async () => {
  const code = await runProxyCommand({
    args: ["ensure"],
    log: () => {},
    probeProxyImpl: dead as any,
    readCloudConfigImpl: () => CLOUD_CONFIG,
    spawnProxyImpl: (() => 4321) as any,
  });

  assert.equal(code, 1);
});

test("ensure: local mode (no cloud config) still uses the docker compose strategy", async () => {
  let composeUpCalls = 0;
  let spawnCalls = 0;
  const probes = [dead, alive];
  let probeCall = 0;

  const code = await runProxyCommand({
    args: ["ensure"],
    log: () => {},
    probeProxyImpl: (() => probes[Math.min(probeCall++, probes.length - 1)]()) as any,
    readCloudConfigImpl: () => null,
    resolveComposeBinImpl: (() => Promise.resolve("docker")) as any,
    composeUpServiceImpl: (() => {
      composeUpCalls++;
      return Promise.resolve();
    }) as any,
    spawnProxyImpl: (() => {
      spawnCalls++;
      return 4321;
    }) as any,
  });

  assert.equal(composeUpCalls, 1);
  assert.equal(spawnCalls, 0);
  assert.equal(code, 0);
});

// --- serve() -------------------------------------------------------------

test("serve: exits 0 (and stays up) once startProxy resolves", async () => {
  const code = await runProxyCommand({
    args: ["serve"],
    log: () => {},
    startProxyImpl: (() =>
      Promise.resolve({ server: {} as any, port: 8787 })) as any,
  });
  assert.equal(code, 0);
});

test("serve: exits non-zero with a one-line message naming the port when already listening", async () => {
  const lines: string[] = [];
  const err = new Error("listen EADDRINUSE: address already in use 127.0.0.1:8787") as NodeJS.ErrnoException;
  err.code = "EADDRINUSE";

  const code = await runProxyCommand({
    args: ["serve"],
    log: (l) => lines.push(l),
    startProxyImpl: (() => Promise.reject(err)) as any,
  });

  assert.equal(code, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /8787/);
});
