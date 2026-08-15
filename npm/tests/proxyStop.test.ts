// `klio proxy stop` — turning the proxy OFF.
//
// Before this existed, `klio uninit` unwired the agents and then ran
// `docker compose stop proxy`, which on a Docker-free cloud machine
// throws. The detached `proxy serve` (processSupervisor.ts spawns it
// `detached` + `unref()`) kept listening on 8787 until reboot, and
// `initCloud` promises "Turn it off any time with `klio uninit`".
//
// The dangerous half is HOW it stops. A pid alone is not proof of
// ownership — Task 6 established that `kill(pid, 0)` cannot tell our
// process from a recycled one — and the pid in a container's health
// body names a process in another namespace, so signalling it on the
// host would kill something entirely unrelated. So `stop` acts only on
// a health body that identifies itself as this Node proxy.
//
// These tests drive the REAL stop path against REAL child processes and
// REAL sockets: the "proxy" is a child process serving a health body
// naming its own pid, so "did the stop work" is answered by the process
// actually being gone, not by a mock recording a call.

import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";

import { runProxyCommand } from "../src/commands/proxy.js";
import { probeProxy as realProbeProxy } from "../src/proxy/supervisor.js";

/**
 * Start a child process serving `body` at `/__klio/health` on an
 * ephemeral port. `body` is a JS expression evaluated INSIDE the child,
 * so it can reference the child's own `process.pid`.
 */
async function startFakeProxy(body: string): Promise<{ child: ChildProcess; port: number }> {
  const source = `
    const http = require("node:http");
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(${body}));
    });
    server.listen(0, "127.0.0.1", () => {
      process.stdout.write(String(server.address().port) + "\\n");
    });
  `;
  const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "ignore"] });
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (c: Buffer) => {
      out += c.toString();
      if (out.includes("\n")) resolve(Number.parseInt(out.trim(), 10));
    });
    child.on("exit", () => reject(new Error("fake proxy exited before listening")));
    setTimeout(() => reject(new Error("fake proxy never reported a port")), 5000);
  });
  return { child, port };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const KLIO_BODY = `{
  status: "ok",
  mode: "inject+capture",
  runtime: "node",
  pid: process.pid,
  config_fingerprint: "0123456789abcdef",
}`;

// The Python proxy's body (proxy/src/klio_proxy/app.py) — no `runtime`,
// no `pid`. It runs in a container, so any pid it might report would
// name a process in another namespace.
const CONTAINER_BODY = `{
  status: "ok",
  mode: "passthrough",
  upstream: "https://api.anthropic.com",
  upstreams: { anthropic: "https://api.anthropic.com" },
  pid: 1,
}`;

test("proxy stop terminates the process the health body names", { timeout: 20000 }, async () => {
  const { child, port } = await startFakeProxy(KLIO_BODY);
  const pid = child.pid as number;
  const lines: string[] = [];
  try {
    assert.equal(isAlive(pid), true, "fixture sanity: the fake proxy is running");

    const code = await runProxyCommand({
      args: ["stop"],
      log: (l) => lines.push(l),
      probeProxyImpl: (() => realProbeProxy(2000, `http://127.0.0.1:${port}/__klio/health`)) as never,
    });

    assert.equal(code, 0, lines.join("\n"));
    assert.equal(await waitForExit(child, 5000), true, "the proxy process must actually be gone");
    assert.match(lines.join("\n"), new RegExp(String(pid)));
  } finally {
    child.kill("SIGKILL");
  }
});

test("proxy stop refuses to signal a pid it cannot prove is ours", { timeout: 20000 }, async () => {
  const { child, port } = await startFakeProxy(CONTAINER_BODY);
  const lines: string[] = [];
  try {
    const code = await runProxyCommand({
      args: ["stop"],
      log: (l) => lines.push(l),
      probeProxyImpl: (() => realProbeProxy(2000, `http://127.0.0.1:${port}/__klio/health`)) as never,
    });

    assert.notEqual(code, 0, "refusing to act must not be reported as a successful stop");
    assert.equal(isAlive(child.pid as number), true, "a responder we cannot identify must be left alone");
    assert.match(lines.join("\n"), /not a Klio Node proxy|klio down/i);
  } finally {
    child.kill("SIGKILL");
  }
});

test("proxy stop is a quiet no-op when nothing is listening", async () => {
  const lines: string[] = [];
  const code = await runProxyCommand({
    args: ["stop"],
    log: (l) => lines.push(l),
    probeProxyImpl: (async () => ({ alive: false, detail: "connection refused" })) as never,
  });
  assert.equal(code, 0, "nothing to stop is success, not failure");
  assert.match(lines.join("\n"), /not (running|answering)/i);
});
