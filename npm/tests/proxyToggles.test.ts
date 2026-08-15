// The two kill switches have to SURVIVE A REBOOT.
//
// `KLIO_PROXY_CAPTURE` is the user's only control over whether their
// conversations leave the machine, and `startProxy` reads `process.env`
// once at boot. The supervised deployment — the only one `klio init`
// produces — starts the proxy from launchd/systemd, whose child
// inherits the SUPERVISOR's environment, never the user's shell. So an
// `export KLIO_PROXY_CAPTURE=off` that visibly worked was silently
// reverted by the next reboot, with capture back on and no signal.
//
// These tests therefore refuse to unit-test the reader in-process. The
// load-bearing ones start a REAL proxy in a REAL child process with a
// DELIBERATELY EMPTY environment (`env -i`, modelled as an explicit
// `env` with nothing but HOME and PATH) and ask the running server, over
// a real socket, what mode it is in.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROXY_TOGGLE_ENV,
  readPersistedToggles,
  resolveProxyToggles,
  setPersistedToggle,
} from "../src/proxy/toggles.js";
import { readCloudConfig, writeCloudConfig } from "../src/cloudConfig.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "klio-toggles-"));
  mkdirSync(join(home, ".klio"), { recursive: true, mode: 0o700 });
  return home;
}

function configPath(home: string): string {
  return join(home, ".klio", "config.json");
}

function writeConfig(home: string, body: unknown): string {
  const path = configPath(home);
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  return path;
}

// ---------------------------------------------------------------------
// Precedence: env (this process only) > persisted config > default on.
// ---------------------------------------------------------------------

test("with nothing set at all, both halves default to on", () => {
  const home = tempHome();
  try {
    const resolved = resolveProxyToggles({ env: {}, configPath: configPath(home) });
    assert.deepEqual(resolved.inject, { enabled: true, source: "default" });
    assert.deepEqual(resolved.capture, { enabled: true, source: "default" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a persisted `off` is honoured when the environment is empty", () => {
  const home = tempHome();
  try {
    writeConfig(home, { apiKey: "k", agentId: "a", baseUrl: "https://b", proxy: { capture: false } });
    const resolved = resolveProxyToggles({ env: {}, configPath: configPath(home) });
    assert.deepEqual(resolved.capture, { enabled: false, source: "config" });
    assert.deepEqual(resolved.inject, { enabled: true, source: "default" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an env var beats the persisted value, in both directions", () => {
  const home = tempHome();
  try {
    writeConfig(home, { apiKey: "k", proxy: { capture: false, inject: false } });
    const resolved = resolveProxyToggles({
      env: { [PROXY_TOGGLE_ENV.capture]: "on" },
      configPath: configPath(home),
    });
    // An explicit non-falsy env spelling re-enables a persisted off.
    assert.deepEqual(resolved.capture, { enabled: true, source: "env" });
    // …and the half the env says nothing about keeps the persisted off.
    assert.deepEqual(resolved.inject, { enabled: false, source: "config" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("every documented spelling of off is accepted, and blanks are ignored", () => {
  const home = tempHome();
  try {
    const path = configPath(home);
    for (const spelling of ["off", "OFF", " false ", "0", "no"]) {
      const resolved = resolveProxyToggles({
        env: { [PROXY_TOGGLE_ENV.capture]: spelling },
        configPath: path,
      });
      assert.equal(resolved.capture.enabled, false, `${JSON.stringify(spelling)} must mean off`);
    }
    // An empty string is what a shell leaves behind after `unset`-adjacent
    // mistakes (`export KLIO_PROXY_CAPTURE=`), and must not be read as
    // either instruction.
    const blank = resolveProxyToggles({
      env: { [PROXY_TOGGLE_ENV.capture]: "" },
      configPath: path,
    });
    assert.deepEqual(blank.capture, { enabled: true, source: "default" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a malformed or absent config never throws — it reads as 'nothing persisted'", () => {
  const home = tempHome();
  try {
    assert.deepEqual(readPersistedToggles(configPath(home)), {});
    writeFileSync(configPath(home), "{not json", { mode: 0o600 });
    assert.deepEqual(readPersistedToggles(configPath(home)), {});
    writeConfig(home, { apiKey: "k", proxy: "nonsense" });
    assert.deepEqual(readPersistedToggles(configPath(home)), {});
    writeConfig(home, { apiKey: "k", proxy: { capture: "off" } });
    assert.deepEqual(readPersistedToggles(configPath(home)), {}, "only real booleans count");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// Writing the toggle must never cost the user their API key, and must
// never widen the permissions of the file that holds it.
// ---------------------------------------------------------------------

test("setPersistedToggle preserves the credentials already in the file", () => {
  const home = tempHome();
  try {
    const path = configPath(home);
    writeConfig(home, { apiKey: "secret-key", agentId: "agent-1", baseUrl: "https://brain" });
    setPersistedToggle("capture", false, path);

    const config = readCloudConfig(path);
    assert.equal(config?.apiKey, "secret-key");
    assert.equal(config?.agentId, "agent-1");
    assert.equal(config?.baseUrl, "https://brain");
    assert.deepEqual(readPersistedToggles(path), { capture: false });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setPersistedToggle keeps the config file 0600", () => {
  const home = tempHome();
  try {
    const path = configPath(home);
    writeConfig(home, { apiKey: "secret-key" });
    chmodSync(path, 0o644); // simulate a file an older install left wide open
    setPersistedToggle("capture", false, path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setPersistedToggle refuses to clobber a config file it cannot parse", () => {
  const home = tempHome();
  try {
    const path = configPath(home);
    writeFileSync(path, '{"apiKey": "secret-key"', { mode: 0o600 });
    assert.throws(() => setPersistedToggle("capture", false, path), /could not be parsed/i);
    // The unreadable bytes — which may still hold a recoverable key —
    // are left exactly as they were.
    assert.equal(readFileSync(path, "utf8"), '{"apiKey": "secret-key"');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setPersistedToggle works on a machine with no config file yet", () => {
  const home = tempHome();
  try {
    const path = join(home, "fresh", ".klio", "config.json");
    setPersistedToggle("capture", false, path);
    assert.deepEqual(readPersistedToggles(path), { capture: false });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// Re-running `klio init` must not silently re-enable capture.
// ---------------------------------------------------------------------

test("writeCloudConfig preserves a persisted opt-out", () => {
  const home = tempHome();
  try {
    const path = configPath(home);
    writeConfig(home, { apiKey: "old", agentId: "a", baseUrl: "https://b" });
    setPersistedToggle("capture", false, path);

    // A second `klio init` with a rotated key.
    writeCloudConfig({ apiKey: "new", agentId: "a", baseUrl: "https://b" }, path);

    assert.equal(readCloudConfig(path)?.apiKey, "new");
    assert.deepEqual(
      readPersistedToggles(path),
      { capture: false },
      "re-running init must not silently turn the user's conversations back on",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// THE ONE THAT MATTERS: a real proxy process, started with an empty
// environment, exactly as launchd/systemd starts it.
// ---------------------------------------------------------------------

/**
 * Start the REAL `startProxy` in a REAL child process whose environment
 * contains only what is handed in — the launchd/systemd case, where the
 * user's shell exports are simply not there. Resolves with the `mode`
 * the running server reports over a real socket.
 */
async function realProxyMode(
  home: string,
  env: Record<string, string>,
): Promise<string> {
  const script =
    "import { startProxy } from './src/proxy/server.ts';" +
    "const { server, port } = await startProxy({ port: 0, host: '127.0.0.1' });" +
    "const res = await fetch(`http://127.0.0.1:${port}/__klio/health`);" +
    "process.stdout.write(JSON.stringify(await res.json()));" +
    "server.close();";

  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: REPO_ROOT,
        // The whole point: NOT `...process.env`. The child gets exactly
        // this and nothing else, which is what `env -i` produces and
        // what a launchd-spawned `proxy ensure` child actually sees.
        env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && stdout === "") {
        reject(new Error(`child exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve((JSON.parse(stdout) as { mode: string }).mode);
      } catch (err) {
        reject(new Error(`unparseable health body ${JSON.stringify(stdout)}: ${String(err)}\n${stderr}`));
      }
    });
  });
}

test(
  "a real proxy started with an EMPTY environment honours the persisted capture opt-out",
  { timeout: 30_000 },
  async () => {
    const home = tempHome();
    try {
      writeConfig(home, {
        apiKey: "test-key",
        agentId: "test-agent",
        baseUrl: "https://brain.invalid",
      });

      // Baseline: nothing persisted, empty environment → both halves on.
      assert.equal(
        await realProxyMode(home, {}),
        "inject+capture",
        "capture is on by default when a cloud config is present",
      );

      // The user turns capture off. This is the ONLY thing that changes.
      setPersistedToggle("capture", false, configPath(home));

      assert.equal(
        await realProxyMode(home, {}),
        "inject",
        "the opt-out must survive a start with no environment at all — " +
          "this is every launchd/systemd restart, and every reboot",
      );

      // And an env var in the CURRENT process still wins, so the
      // documented shell-level switch keeps working.
      assert.equal(
        await realProxyMode(home, { [PROXY_TOGGLE_ENV.inject]: "off" }),
        "passthrough",
        "an env var must still be able to turn the other half off too",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
