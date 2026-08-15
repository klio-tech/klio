// Tests for the proxy offer on the cloud init path
// (src/commands/initCloud.ts: maybeOfferProxy + wireProxyStack).
//
// maybeOfferProxy is exercised with injected `ask`/`wire` stubs — no
// TTY, filesystem, or subprocess involved. wireProxyStack is exercised
// with its own injected collaborators so we can drive each of the three
// real steps (wireProxy / installSupervisor / spawnProxy) into failure
// independently and check the rollback behaviour, again without
// touching the real filesystem or spawning anything.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  maybeOfferProxy,
  wireProxyStack,
  type WireProxyStackOptions,
} from "../src/commands/initCloud.js";
import type { WireProxyResult } from "../src/proxy/wiring.js";
import type { InstallResult } from "../src/proxy/supervisor.js";

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

test("happy path: all three steps run in order and nothing is rolled back", async () => {
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
    unwireProxyFn: () => {
      calls.push("unwire");
      return okWiring();
    },
  });

  await wireProxyStack(opts);
  assert.deepEqual(calls, ["wire", "supervisor", "spawn"]);
});
