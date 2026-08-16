// `klio doctor` on a Docker-free machine.
//
// The bug: `ensure()` (commands/proxy.ts) learned the cloud/local branch
// — cloud revives by spawning a detached `proxy serve`, local by `docker
// compose up` — and doctor did not. doctor went straight to
// `resolveComposeBin()`, so on a cloud machine with no Docker a dead
// proxy printed "…could not be restarted: Is Docker running?" and
// advised `docker logs klio-proxy`, while ANTHROPIC_BASE_URL pointed at
// a dead port and the user's agent could not reach a model at all.
//
// That matters more than a wrong message: `wiring.ts`'s trade-offs block
// — the informed-consent surface shown before the user opts in —
// promises "A supervisor keeps it alive; `klio doctor` checks and
// heals". On the cloud path it could not heal at all.
//
// HOME is redirected at a temp directory throughout so the settings and
// supervisor checks operate on scratch files rather than the
// developer's real ~/.claude/settings.json.

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { doctor } from "../src/commands/doctor.js";

const CLOUD_CONFIG = { apiKey: "ag_live_test", agentId: "a", baseUrl: "https://brain.test" };

async function inScratchHome(body: () => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "klio-doctor-"));
  const saved = process.env["HOME"];
  try {
    process.env["HOME"] = home;
    await body();
  } finally {
    if (saved === undefined) delete process.env["HOME"];
    else process.env["HOME"] = saved;
    rmSync(home, { recursive: true, force: true });
  }
}

test("doctor heals a dead cloud proxy by spawning it, never by reaching for Docker", async () => {
  await inScratchHome(async () => {
    let spawnCalls = 0;
    let composeResolved = false;
    let probeCalls = 0;
    const lines: string[] = [];

    const code = await doctor({
      log: (l) => lines.push(l),
      skipEndToEnd: true,
      readCloudConfigFn: () => CLOUD_CONFIG,
      // Dead on the first probe, alive once revived.
      probeProxyFn: async () => {
        probeCalls++;
        return probeCalls === 1
          ? { alive: false, detail: "connection refused" }
          : { alive: true, detail: "alive (inject+capture)" };
      },
      spawnProxyFn: () => {
        spawnCalls++;
        return 4242;
      },
      resolveComposeBinFn: async () => {
        composeResolved = true;
        throw new Error("Is Docker running?");
      },
      sleepFn: async () => {},
    } as never);

    const out = lines.join("\n");
    assert.equal(spawnCalls, 1, "the cloud path must revive by spawning the proxy");
    assert.equal(composeResolved, false, "a Docker-free machine must never be asked for docker compose");
    assert.match(out, /Proxy process/);
    assert.match(out, /restarted/i);
    assert.doesNotMatch(out, /Is Docker running\?/);
    assert.equal(code, 0, out);
  });
});

test("a cloud proxy that will not come back is reported without blaming Docker", async () => {
  await inScratchHome(async () => {
    const lines: string[] = [];
    const code = await doctor({
      log: (l) => lines.push(l),
      skipEndToEnd: true,
      readCloudConfigFn: () => CLOUD_CONFIG,
      probeProxyFn: async () => ({ alive: false, detail: "connection refused" }),
      spawnProxyFn: () => 4242,
      resolveComposeBinFn: async () => {
        throw new Error("Is Docker running?");
      },
      sleepFn: async () => {},
    } as never);

    const out = lines.join("\n");
    assert.equal(code, 1, "a dead proxy is a failure");
    assert.doesNotMatch(out, /docker/i, `cloud advice must not mention Docker:\n${out}`);
    // The user needs a next step that exists on their machine.
    assert.match(out, /klio proxy serve|klio uninit/);
  });
});

test("doctor on the local (Docker) path still restarts the container", async () => {
  await inScratchHome(async () => {
    let composeUpCalls = 0;
    let spawnCalls = 0;
    let probeCalls = 0;

    const code = await doctor({
      log: () => {},
      skipEndToEnd: true,
      readCloudConfigFn: () => null,
      probeProxyFn: async () => {
        probeCalls++;
        return probeCalls === 1
          ? { alive: false, detail: "connection refused" }
          : { alive: true, detail: "alive (passthrough)" };
      },
      spawnProxyFn: () => {
        spawnCalls++;
        return 4242;
      },
      resolveComposeBinFn: async () => ({ cmd: "docker", prefix: ["compose"] }),
      composeUpServiceFn: async () => {
        composeUpCalls++;
      },
      sleepFn: async () => {},
    } as never);

    assert.equal(composeUpCalls, 1, "local mode must still use docker compose");
    assert.equal(spawnCalls, 0, "local mode must not spawn a host process");
    assert.equal(code, 0);
  });
});

test("a healthy proxy is left alone on both paths", async () => {
  await inScratchHome(async () => {
    for (const config of [CLOUD_CONFIG, null]) {
      let touched = 0;
      const code = await doctor({
        log: () => {},
        skipEndToEnd: true,
        readCloudConfigFn: () => config,
        probeProxyFn: async () => ({ alive: true, detail: "alive (inject+capture)" }),
        spawnProxyFn: () => {
          touched++;
          return 1;
        },
        resolveComposeBinFn: async () => {
          touched++;
          throw new Error("must not be called");
        },
        sleepFn: async () => {},
      } as never);
      assert.equal(touched, 0, "an answering proxy must not be restarted");
      assert.equal(code, 0);
    }
  });
});
