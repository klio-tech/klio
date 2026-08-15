// Tests for the proxy offer on the cloud init path
// (src/commands/initCloud.ts: maybeOfferProxy + wireProxyStack +
// buildProxyAsk).
//
// maybeOfferProxy is exercised with injected `ask`/`wire` stubs — no
// TTY, filesystem, or subprocess involved. wireProxyStack is exercised
// with its own injected collaborators so we can drive each of the three
// real steps (wireProxy / installSupervisor / spawnProxy) into failure
// independently and check the rollback behaviour. Two exceptions, by
// design: `buildProxyAsk` is driven through the REAL `prompt()`
// implementation (a mocked `ask` could never have caught the hang this
// guards against), and one wireProxyStack test drives the REAL
// `spawnProxy` and `probeProxy` against a real listener (a mocked
// spawn/probe pair could never have caught the "pid proves nothing"
// bug this guards against).

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  buildProxyAsk,
  maybeOfferProxy,
  wireProxyStack,
  type WireProxyStackOptions,
} from "../src/commands/initCloud.js";
import type { WireProxyResult } from "../src/proxy/wiring.js";
import type { InstallResult } from "../src/proxy/supervisor.js";
import { prompt as realPrompt } from "../src/prompt.js";
import { spawnProxy as realSpawnProxy } from "../src/proxy/processSupervisor.js";
import { probeProxy as realProbeProxy } from "../src/proxy/supervisor.js";

// ---------------------------------------------------------------------
// maybeOfferProxy — the brief's floor tests, verbatim.
// ---------------------------------------------------------------------

test("bare Enter declines — the default is no", async () => {
  let wired = false;
  const result = await maybeOfferProxy({
    ask: async () => "",
    anyProxyableAgent: true,
    wire: async () => {
      wired = true;
    },
  });
  assert.equal(result.enabled, false);
  assert.equal(wired, false);
});

test("an explicit yes wires the proxy", async () => {
  let wired = false;
  const result = await maybeOfferProxy({
    ask: async () => "y",
    anyProxyableAgent: true,
    wire: async () => {
      wired = true;
    },
  });
  assert.equal(result.enabled, true);
  assert.equal(wired, true);
});

test("no proxyable agent means no prompt at all", async () => {
  let asked = false;
  const result = await maybeOfferProxy({
    ask: async () => {
      asked = true;
      return "y";
    },
    anyProxyableAgent: false,
    wire: async () => {},
  });
  assert.equal(asked, false);
  assert.equal(result.enabled, false);
});

test("a wiring failure is reported, not thrown", async () => {
  const result = await maybeOfferProxy({
    ask: async () => "y",
    anyProxyableAgent: true,
    wire: async () => {
      throw new Error("settings.json is read-only");
    },
  });
  assert.equal(result.enabled, false);
  assert.match(result.error ?? "", /read-only/);
});

// ---------------------------------------------------------------------
// maybeOfferProxy — answer parsing.
// ---------------------------------------------------------------------

test("y/yes accept in any case; n, empty, whitespace, and junk decline", async () => {
  const accept = ["y", "yes", "Y", "YES", "Yes"];
  for (const answer of accept) {
    let wired = false;
    const result = await maybeOfferProxy({
      ask: async () => answer,
      anyProxyableAgent: true,
      wire: async () => {
        wired = true;
      },
    });
    assert.equal(result.enabled, true, `expected "${answer}" to accept`);
    assert.equal(wired, true, `expected "${answer}" to wire`);
  }

  const decline = ["n", "no", "N", "", "   ", "sure", "yep", "yy"];
  for (const answer of decline) {
    let wired = false;
    const result = await maybeOfferProxy({
      ask: async () => answer,
      anyProxyableAgent: true,
      wire: async () => {
        wired = true;
      },
    });
    assert.equal(result.enabled, false, `expected "${answer}" to decline`);
    assert.equal(wired, false, `expected "${answer}" not to wire`);
  }
});

// ---------------------------------------------------------------------
// wireProxyStack — the three real steps, each driven to failure.
// ---------------------------------------------------------------------

function okWiring(): WireProxyResult {
  return { skipped: [], errors: [] };
}

function okSupervisor(): InstallResult {
  return {
    kind: "launchd",
    installed: true,
    paths: ["/fake/plist"],
    detail: "launchd agent loaded",
  };
}

function stackSeams(
  overrides: Partial<WireProxyStackOptions> & {
    wireProxyCalls?: { count: number };
    unwireProxyCalls?: { count: number };
    installSupervisorCalls?: { count: number };
    spawnProxyCalls?: { count: number };
  } = {},
): WireProxyStackOptions {
  const lines: string[] = [];
  return {
    log: (line) => lines.push(line),
    wireProxyFn: () => okWiring(),
    unwireProxyFn: () => okWiring(),
    installSupervisorFn: async () => okSupervisor(),
    spawnProxyFn: () => 4242,
    // Default to "the proxy answers immediately" so tests that aren't
    // specifically about the probe step don't pay its retry delay or
    // (worse) hit the real network. Keep the retry loop itself real —
    // just make it resolve on the first attempt with a near-zero delay.
    probeProxyFn: async () => ({ alive: true, detail: "ok" }),
    probeAttempts: 1,
    probeIntervalMs: 0,
    sleepFn: async () => {},
    resolveKlioCommandFn: () => ["klio", "proxy", "ensure"],
    cliPath: "/fake/cli.mjs",
    version: "0.0.0-test",
    ...overrides,
  };
}

test("step 1 (wireProxy) failure rolls back and reports an actionable message; init stays up", async () => {
  let unwireCalled = false;
  const opts = stackSeams({
    wireProxyFn: () => ({
      skipped: [],
      errors: [{ agent: "codex", message: "config.toml is read-only" }],
    }),
    unwireProxyFn: (o) => {
      unwireCalled = true;
      return okWiring();
    },
  });

  // wireProxyStack itself throws — that's the seam maybeOfferProxy
  // catches so `init` never crashes.
  await assert.rejects(() => wireProxyStack(opts), /read-only/);
  assert.equal(unwireCalled, true, "step 1 failure must trigger a rollback");

  // Driven through maybeOfferProxy end to end: init stays successful
  // and the failure is reported, not thrown out of the flow.
  const result = await maybeOfferProxy({
    ask: async () => "y",
    anyProxyableAgent: true,
    wire: () => wireProxyStack(stackSeams({
      wireProxyFn: () => ({
        skipped: [],
        errors: [{ agent: "codex", message: "config.toml is read-only" }],
      }),
    })),
  });
  assert.equal(result.enabled, false);
  assert.match(result.error ?? "", /config\.toml is read-only/);
  assert.match(result.error ?? "", /rolled back/);
});

test("step 2 (installSupervisor) failure is reported but does NOT roll back — the proxy still comes up", async () => {
  let unwireCalled = false;
  let spawnCalled = false;
  const lines: string[] = [];
  const opts = stackSeams({
    log: (line) => lines.push(line),
    installSupervisorFn: async () => ({
      kind: "launchd",
      installed: false,
      paths: [],
      detail: "plist written but launchctl bootstrap failed: permission denied",
    }),
    unwireProxyFn: (o) => {
      unwireCalled = true;
      return okWiring();
    },
    spawnProxyFn: () => {
      spawnCalled = true;
      return 4242;
    },
  });

  // Does not throw — a degraded supervisor is not fatal by design.
  await wireProxyStack(opts);
  assert.equal(unwireCalled, false, "supervisor failure must not roll back the wiring");
  assert.equal(spawnCalled, true, "the stack must proceed to step 3");
  assert.ok(
    lines.some((l) => l.includes("permission denied")),
    "the supervisor failure detail must be reported",
  );

  // Driven through maybeOfferProxy: init reports success (the proxy is
  // genuinely running), with the degraded-supervisor detail surfaced
  // via the log, not swallowed.
  const offerLines: string[] = [];
  const result = await maybeOfferProxy({
    ask: async () => "y",
    anyProxyableAgent: true,
    wire: () =>
      wireProxyStack(
        stackSeams({
          log: (l) => offerLines.push(l),
          installSupervisorFn: async () => ({
            kind: "launchd",
            installed: false,
            paths: [],
            detail: "plist written but launchctl bootstrap failed: permission denied",
          }),
        }),
      ),
  });
  assert.equal(result.enabled, true);
  assert.equal(result.error, undefined);
  assert.ok(offerLines.some((l) => l.includes("permission denied")));
});

test("step 3 (spawnProxy) failure rolls back and reports an actionable message; init stays up", async () => {
  let unwireCalled = false;
  const opts = stackSeams({
    spawnProxyFn: () => {
      throw new Error("EADDRINUSE: address already in use 127.0.0.1:8787");
    },
    unwireProxyFn: (o) => {
      unwireCalled = true;
      return okWiring();
    },
  });

  await assert.rejects(() => wireProxyStack(opts), /EADDRINUSE/);
  assert.equal(unwireCalled, true, "step 3 failure must trigger a rollback");

  const result = await maybeOfferProxy({
    ask: async () => "y",
    anyProxyableAgent: true,
    wire: () =>
      wireProxyStack(
        stackSeams({
          spawnProxyFn: () => {
            throw new Error("EADDRINUSE: address already in use 127.0.0.1:8787");
          },
        }),
      ),
  });
  assert.equal(result.enabled, false);
  assert.match(result.error ?? "", /EADDRINUSE/);
  assert.match(result.error ?? "", /rolled back/);
});

test("happy path: all four steps run in order and nothing is rolled back", async () => {
  const calls: string[] = [];
  const opts = stackSeams({
    wireProxyFn: () => {
      calls.push("wire");
      return okWiring();
    },
    installSupervisorFn: async () => {
      calls.push("supervisor");
      return okSupervisor();
    },
    spawnProxyFn: () => {
      calls.push("spawn");
      return 4242;
    },
    probeProxyFn: async () => {
      calls.push("probe");
      return { alive: true, detail: "ok" };
    },
    unwireProxyFn: () => {
      calls.push("unwire");
      return okWiring();
    },
  });

  await wireProxyStack(opts);
  assert.deepEqual(calls, ["wire", "supervisor", "spawn", "probe"]);
});

// ---------------------------------------------------------------------
// Critical 1 — a pid alone must never be treated as proof the proxy is
// answering. spawnProxy can return a pid for a process that loses an
// EADDRINUSE race and exits; wireProxyStack must reprobe and roll back
// when the proxy never actually answers.
// ---------------------------------------------------------------------

test("spawnProxy returns a pid but the proxy never answers (busy port) — rollback, mocked probe", async () => {
  let unwireCalled = false;
  const result = await maybeOfferProxy({
    ask: async () => "y",
    anyProxyableAgent: true,
    wire: () =>
      wireProxyStack(
        stackSeams({
          // A pid comes back immediately — this is exactly what a lost
          // EADDRINUSE race looks like from spawnProxy's point of view.
          spawnProxyFn: () => 4242,
          // But the health check never goes green.
          probeProxyFn: async () => ({ alive: false, detail: "connection refused" }),
          probeAttempts: 2,
          unwireProxyFn: (o) => {
            unwireCalled = true;
            return okWiring();
          },
        }),
      ),
  });
  assert.equal(result.enabled, false, "a proxy that never answers must not report success");
  assert.match(result.error ?? "", /did not answer/);
  assert.match(result.error ?? "", /rolled back/);
  assert.equal(unwireCalled, true, "a silently-dead spawn must still trigger a rollback");
});

test(
  "real spawnProxy + real probeProxy against a real listener: a busy port is not silently reported as success",
  { timeout: 8000 },
  async () => {
    // A real HTTP server standing in for "something is already bound to
    // the proxy's port, so the real proxy process can never bind it and
    // exits almost immediately." It answers requests, but not with the
    // proxy's health-check body — exactly what a stray non-Klio listener
    // (or the just-exited proxy child's socket lingering in TIME_WAIT on
    // some platforms) looks like to a health probe.
    const blocker = createServer((_req, res) => res.end("not klio"));
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as AddressInfo).port;

    const spawnedChildren: ChildProcess[] = [];
    let unwireCalled = false;

    try {
      const result = await maybeOfferProxy({
        ask: async () => "y",
        anyProxyableAgent: true,
        wire: () =>
          wireProxyStack({
            log: () => {},
            unwireProxyFn: () => {
              unwireCalled = true;
              return { skipped: [], errors: [] };
            },
            // The REAL spawnProxy (processSupervisor.ts), unmocked. Its
            // own `spawnImpl` seam is used to launch a harmless,
            // near-instant child instead of the actual `proxy serve`
            // subcommand — what that child does is irrelevant, because
            // the blocker above already occupies the port we probe
            // below, so the REAL probeProxy() call will correctly
            // report "not alive" no matter what this child does. The
            // pid-file write is stubbed out so the test never touches
            // `~/.klio`.
            spawnProxyFn: (o) =>
              realSpawnProxy({
                ...o,
                writeFileImpl: () => {},
                spawnImpl: ((_command, _args, options) => {
                  const child = nodeSpawn(process.execPath, ["-e", "0"], options);
                  spawnedChildren.push(child);
                  return child;
                }) as typeof nodeSpawn,
              }),
            // The REAL probeProxy (supervisor.ts), unmocked — only the
            // target URL is overridden so the test never touches the
            // real, fixed 8787 proxy port (matching how proxyServer.test.ts
            // simulates "port busy" against an ephemeral port rather
            // than the constant).
            probeProxyFn: () =>
              realProbeProxy(200, `http://127.0.0.1:${port}/__klio/health`),
            probeAttempts: 2,
            probeIntervalMs: 10,
          }),
      });

      assert.equal(result.enabled, false, "a busy port must not be reported as success");
      assert.match(result.error ?? "", /did not answer/);
      assert.equal(unwireCalled, true, "the real spawn+probe path must still trigger a rollback");
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
      for (const child of spawnedChildren) {
        try {
          child.kill();
        } catch {
          /* already exited — fine */
        }
      }
    }
  },
);

// ---------------------------------------------------------------------
// Critical 2 — a bare Enter must decline instantly, and a closed/piped
// stdin must never hang. Driven through the REAL prompt() so a change
// that reintroduces the missing `default` can't hide behind a mock.
// ---------------------------------------------------------------------

test(
  "buildProxyAsk + real prompt(): bare Enter declines instantly",
  { timeout: 2000 },
  async () => {
    const stdin = new Readable({ read() {} });
    const written: string[] = [];
    const stdout = new Writable({
      write(chunk, _enc, cb) {
        written.push(chunk.toString());
        cb();
      },
    });

    const ask = buildProxyAsk((o) => realPrompt({ ...o, stdin, stdout }));
    const pending = ask(
      "Route model calls through a local Klio proxy? ... [y/N]: ",
    );
    stdin.push("\n");
    const value = await pending;
    assert.equal(value, "n");
    assert.doesNotMatch(written.join(""), /value required/);
  },
);

test(
  "buildProxyAsk + real prompt(): a closed/piped stdin resolves promptly instead of hanging",
  { timeout: 2000 },
  async () => {
    const stdin = new Readable({ read() {} });
    const stdout = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });

    const ask = buildProxyAsk((o) => realPrompt({ ...o, stdin, stdout }));
    const pending = ask(
      "Route model calls through a local Klio proxy? ... [y/N]: ",
    );
    // End the stream with no data at all — simulates a piped/redirected
    // stdin that closes immediately (e.g. `klio init < /dev/null`, or
    // any CI runner that doesn't attach a TTY).
    stdin.push(null);
    const value = await pending;
    assert.equal(value, "n");
  },
);

// ---------------------------------------------------------------------
// Important 3 — a failed rollback must be reported as failed, not
// silently claimed clean.
// ---------------------------------------------------------------------

test("a rollback that itself partially fails says so, and names what's still wired", async () => {
  const result = await maybeOfferProxy({
    ask: async () => "y",
    anyProxyableAgent: true,
    wire: () =>
      wireProxyStack(
        stackSeams({
          spawnProxyFn: () => {
            throw new Error("EADDRINUSE");
          },
          unwireProxyFn: () => ({
            skipped: [],
            errors: [{ agent: "codex", message: "config.toml is locked by another process" }],
          }),
        }),
      ),
  });
  assert.equal(result.enabled, false);
  assert.match(result.error ?? "", /EADDRINUSE/);
  assert.match(result.error ?? "", /rollback ALSO failed/);
  assert.match(result.error ?? "", /codex/);
  assert.match(result.error ?? "", /config\.toml is locked/);
  assert.match(result.error ?? "", /klio uninit/);
});
