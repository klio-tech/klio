// `klio proxy serve --port/--host/--upstream`, and the env spellings.
//
// These seams exist because the first live verification of this proxy
// could not be run in place: it had to patch two literals in a COPY OF
// THE COMPILED BUILD (`dist/proxy/constants.js`'s port, and
// `dist/proxy/server.js`'s upstream host), because 8787 was occupied by
// the developer's own supervised proxy. The last test in this file is
// the one that matters — it drives the REAL `startProxy` through the
// REAL command onto an ephemeral port and a local upstream, which is
// exactly what a repeat of that verification needs and could not do.

import { strict as assert } from "node:assert";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { runProxyCommand } from "../src/commands/proxy.js";
import { PROXY_HOST, PROXY_PORT } from "../src/proxy/constants.js";
import { resolveServeOptions, type ServeOptions } from "../src/proxy/serveOptions.js";

function ok(args: string[], env: NodeJS.ProcessEnv = {}): ServeOptions {
  const result = resolveServeOptions(args, env);
  if (!result.ok) return assert.fail(`expected success, got ${result.error}`);
  return result.options;
}

function err(args: string[], env: NodeJS.ProcessEnv = {}): string {
  const result = resolveServeOptions(args, env);
  if (result.ok) return assert.fail("expected a rejection");
  return result.error;
}

test("defaults to the shipped port and host when nothing overrides them", () => {
  assert.deepEqual(ok([]), { port: PROXY_PORT, host: PROXY_HOST });
});

test("--port and --host override the defaults, in both spellings", () => {
  assert.equal(ok(["--port", "18787"]).port, 18787);
  assert.equal(ok(["--port=18787"]).port, 18787);
  assert.equal(ok(["--host", "0.0.0.0"]).host, "0.0.0.0");
  assert.equal(ok(["--port", "0"]).port, 0, "0 means an ephemeral port, and is allowed");
});

test("KLIO_PROXY_PORT and KLIO_PROXY_HOST reach the Node proxy", () => {
  // Before this, KLIO_PROXY_PORT existed only for the Docker/Python
  // proxy, and setting it did nothing at all to `klio proxy serve`.
  const options = ok([], { KLIO_PROXY_PORT: "18787", KLIO_PROXY_HOST: "127.0.0.2" });
  assert.equal(options.port, 18787);
  assert.equal(options.host, "127.0.0.2");
});

test("an explicit flag beats the environment", () => {
  assert.equal(ok(["--port", "19999"], { KLIO_PROXY_PORT: "18787" }).port, 19999);
});

test("--upstream <url> replaces the default anthropic upstream", () => {
  assert.deepEqual(ok(["--upstream", "https://litellm.oppla.dev"]).upstreams, {
    anthropic: "https://litellm.oppla.dev",
  });
});

test("--upstream <name>=<url> names one, and repeats accumulate", () => {
  assert.deepEqual(
    ok(["--upstream", "openai=https://oai.example", "--upstream", "https://ant.example"]).upstreams,
    { openai: "https://oai.example", anthropic: "https://ant.example" },
  );
});

test("a trailing slash is trimmed, so base+path cannot double it", () => {
  assert.deepEqual(ok(["--upstream", "https://host.example/"]).upstreams, { anthropic: "https://host.example" });
});

test("KLIO_PROXY_UPSTREAM accepts the same forms, comma separated", () => {
  assert.deepEqual(ok([], { KLIO_PROXY_UPSTREAM: "https://a.example,openai=https://b.example" }).upstreams, {
    anthropic: "https://a.example",
    openai: "https://b.example",
  });
});

test("a bad value is refused, never guessed at", () => {
  assert.match(err(["--port", "not-a-number"]), /--port must be a number/);
  assert.match(err(["--port", "70000"]), /between 0 and 65535/);
  assert.match(err([], { KLIO_PROXY_PORT: "eight" }), /KLIO_PROXY_PORT must be a number/);
  assert.match(err(["--upstream", "ftp://host.example"]), /must be http or https/);
  assert.match(err(["--upstream", "not-a-url"]), /must be an absolute URL/);
  assert.match(err(["--upstream"]), /--upstream needs a value/);
  assert.match(err(["--nonsense"]), /unknown option --nonsense/);
});

test("no upstream override means the key is absent, so the defaults stand", () => {
  assert.equal("upstreams" in ok(["--port", "1"]), false);
});

// --- the seam driven end to end -----------------------------------------

test("serve honours --port and --upstream through the real startProxy", async () => {
  // A local stand-in for the model API, so the proxy has somewhere real
  // to forward to.
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: "from the overridden upstream" }] }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  // Bind an ephemeral port first, only to learn a free number; release
  // it before handing that number to `serve`.
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const freePort = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));

  let started: { server: http.Server; port: number } | undefined;
  const code = await runProxyCommand({
    args: ["serve", "--port", String(freePort), "--upstream", `http://127.0.0.1:${upstreamPort}`],
    log: () => {},
    env: {},
    // The REAL startProxy, wrapped only to capture the handle so this
    // test can shut it down again.
    startProxyImpl: (async (o: Parameters<typeof import("../src/proxy/server.js").startProxy>[0]) => {
      const { startProxy } = await import("../src/proxy/server.js");
      // A config path that does not exist: no credentials are read, and
      // the developer's own ~/.klio/config.json is never touched.
      started = await startProxy({ ...o, configPath: "/nonexistent/klio-serve-options-test/config.json" });
      return started;
    }) as never,
  });

  try {
    assert.equal(code, 0);
    assert.equal(started?.port, freePort, "the proxy must bind the port that was asked for");

    const res = await fetch(`http://127.0.0.1:${freePort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /from the overridden upstream/);
  } finally {
    started?.server.closeAllConnections();
    upstream.closeAllConnections();
    if (started) await new Promise<void>((r) => started!.server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});
