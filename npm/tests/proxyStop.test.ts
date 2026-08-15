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

import { down } from "../src/commands/down.js";
import { runProxyCommand } from "../src/commands/proxy.js";
import { probeProxy as realProbeProxy } from "../src/proxy/supervisor.js";
import { stopProxy } from "../src/proxy/stop.js";

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

// A proxy from an OLDER release answers `{"status":"ok"}` and nothing
// else — no `runtime`, no `pid`. Found live, during before/after
// measurement: upgrading and then running `klio proxy stop` classified
// it as "not a Klio Node proxy" and pointed at `klio down`, which is
// the local Docker stack's command and does nothing here. It survived,
// the newly spawned proxy lost EADDRINUSE, and the health probe went
// green against the OLD process — the exact survivor failure this
// command exists to prevent, just one version further back.
//
// Its pid is genuinely unknowable from the wire (that is why the field
// was added), so this cannot be automated. What it must not do is
// misdiagnose: say what is there and give a remedy that works.
const LEGACY_BODY = `{ status: "ok" }`;

test("an older Klio proxy is named as such, with a remedy that exists", { timeout: 20000 }, async () => {
  const { child, port } = await startFakeProxy(LEGACY_BODY);
  const lines: string[] = [];
  try {
    const code = await runProxyCommand({
      args: ["stop"],
      log: (l) => lines.push(l),
      probeProxyImpl: (() => realProbeProxy(2000, `http://127.0.0.1:${port}/__klio/health`)) as never,
    });

    const out = lines.join("\n");
    assert.notEqual(code, 0);
    assert.equal(isAlive(child.pid as number), true, "we cannot know its pid, so we must not guess one");
    assert.match(out, /older Klio proxy/i, out);
    assert.doesNotMatch(out, /klio down/, "klio down is the Docker stack's command, not this one");
    assert.match(out, /8787/, "the remedy has to tell the user how to find it");
  } finally {
    child.kill("SIGKILL");
  }
});

// ---------------------------------------------------------------------
// A FOREIGN listener on the proxy port must be named, not silently
// reported as "nothing is running".
//
// `probeProxy` set `alive = body.status === "ok"`, so `stopProxy`
// returned at `!first.alive` before it could ever reach the arm that
// says "something is answering on the proxy port, but it is not a Klio
// proxy". That arm required `alive && status !== "ok"`, which the
// definition of `alive` makes impossible: the docblock claimed to tell
// three responders apart, and it told two apart. Live, a dev server on
// 8787 produced `klio proxy: not running (unhealthy)` and exit 0, while
// `klio down` printed `— not running` with the port firmly occupied —
// the user is then told nothing is wrong, and the next `klio init`
// loses the EADDRINUSE race to a listener nobody mentioned.
//
// Three shapes a non-Klio responder takes, all of them real: JSON that
// is not a health body, a plain-text/HTML dev server, and an HTTP error
// status.
// ---------------------------------------------------------------------

/** Serve `body` verbatim with the given status and content type. */
async function startForeignListener(
  status: number,
  contentType: string,
  body: string,
): Promise<{ child: ChildProcess; port: number }> {
  const source = `
    const http = require("node:http");
    const server = http.createServer((req, res) => {
      res.writeHead(${status}, { "content-type": ${JSON.stringify(contentType)} });
      res.end(${JSON.stringify(body)});
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
    child.on("exit", () => reject(new Error("foreign listener exited before listening")));
    setTimeout(() => reject(new Error("foreign listener never reported a port")), 5000);
  });
  return { child, port };
}

const FOREIGN_RESPONDERS: { name: string; status: number; type: string; body: string }[] = [
  { name: "a JSON API that is not ours", status: 200, type: "application/json", body: '{"ok":true}' },
  { name: "a dev server serving HTML", status: 200, type: "text/html", body: "<!doctype html><h1>vite</h1>" },
  { name: "a service answering 404", status: 404, type: "text/plain", body: "not found" },
];

for (const responder of FOREIGN_RESPONDERS) {
  test(
    `proxy stop tells the user ${responder.name} is holding the port`,
    { timeout: 20000 },
    async () => {
      const { child, port } = await startForeignListener(
        responder.status,
        responder.type,
        responder.body,
      );
      const lines: string[] = [];
      try {
        const code = await runProxyCommand({
          args: ["stop"],
          log: (l) => lines.push(l),
          probeProxyImpl: (() =>
            realProbeProxy(2000, `http://127.0.0.1:${port}/__klio/health`)) as never,
        });
        const out = lines.join("\n");
        assert.equal(isAlive(child.pid as number), true, "a foreign listener must be left alone");
        assert.notEqual(code, 0, `an occupied port is not a clean "nothing to stop": ${out}`);
        assert.match(out, /not a Klio proxy/i, out);
        assert.doesNotMatch(out, /not running/i, out);
      } finally {
        child.kill("SIGKILL");
      }
    },
  );
}

test("klio down reports the occupied port too, rather than '— not running'", { timeout: 20000 }, async () => {
  const { child, port } = await startForeignListener(200, "text/html", "<h1>vite</h1>");
  const lines: string[] = [];
  try {
    await down({
      log: (l) => lines.push(l),
      readCloudConfigFn: () => ({ apiKey: "k", agentId: "a", baseUrl: "https://b" }),
      stopProxyFn: () =>
        stopProxy({
          probeImpl: () => realProbeProxy(2000, `http://127.0.0.1:${port}/__klio/health`),
        }),
    });
    const out = lines.join("\n");
    assert.match(out, /not a Klio proxy/i, out);
    assert.doesNotMatch(out, /—\s*not running/i, out);
  } finally {
    child.kill("SIGKILL");
  }
});

// ---------------------------------------------------------------------
// The remedy handed to the user must not have a blast radius we
// ourselves refused to accept.
//
// `kill $(lsof -ti tcp:8787)` selects every process with the port open,
// which is the LISTENER *and* every connected CLIENT. Measured with the
// proxy up and one client attached, `lsof -ti tcp:8787` returned two
// pids — pasting that kill also kills the user's coding agent. Refusing
// to automate port→pid→kill (because a bare pid cannot prove ownership)
// and then printing that exact command for the user to paste is having
// it both ways.
// ---------------------------------------------------------------------

test("no advice this command prints kills anything selected by port alone", { timeout: 20000 }, async () => {
  const bodies = [LEGACY_BODY, CONTAINER_BODY, `{ status: "ok", runtime: "node", mode: "inject" }`];
  for (const body of bodies) {
    const { child, port } = await startFakeProxy(body);
    const lines: string[] = [];
    try {
      await runProxyCommand({
        args: ["stop"],
        log: (l) => lines.push(l),
        probeProxyImpl: (() => realProbeProxy(2000, `http://127.0.0.1:${port}/__klio/health`)) as never,
      });
      const out = lines.join("\n");
      assert.doesNotMatch(out, /kill\s/, `still hands the user a kill command:\n${out}`);
      assert.doesNotMatch(out, /lsof\s+-t/, `-t prints bare pids, which is the foot-gun:\n${out}`);
      if (/lsof/.test(out)) {
        assert.match(
          out,
          /-sTCP:LISTEN/,
          `an lsof suggestion must be scoped to the LISTENER, not every client:\n${out}`,
        );
      }
    } finally {
      child.kill("SIGKILL");
    }
  }
});
