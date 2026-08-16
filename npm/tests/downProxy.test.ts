// `klio down` on a Docker-free machine.
//
// Same gap as `klio doctor` had: `down` means "stop what klio is
// running", and on the cloud path what klio is running is a detached
// `proxy serve` host process, not a compose stack. Going straight to
// `resolveComposeBin()` there fails with a Docker error while the proxy
// keeps listening on 8787.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { down } from "../src/commands/down.js";

const CLOUD_CONFIG = { apiKey: "ag_live_test", agentId: "a", baseUrl: "https://brain.test" };

test("down stops the cloud proxy without touching Docker", async () => {
  let stopCalls = 0;
  let composeResolved = false;
  const lines: string[] = [];

  await down({
    log: (l: string) => lines.push(l),
    readCloudConfigFn: () => CLOUD_CONFIG,
    stopProxyFn: async () => {
      stopCalls++;
      return { stopped: true, wasRunning: true, detail: "stopped the proxy (pid 4242)" };
    },
    resolveComposeBinFn: async () => {
      composeResolved = true;
      throw new Error("Is Docker running?");
    },
  } as never);

  assert.equal(stopCalls, 1);
  assert.equal(composeResolved, false, "cloud mode has no compose stack to resolve");
  assert.match(lines.join("\n"), /stopped the proxy/);
});

test("down on the local path still brings the whole stack down", async () => {
  let composeDownCalls = 0;
  let stopCalls = 0;

  await down({
    log: () => {},
    readCloudConfigFn: () => null,
    stopProxyFn: async () => {
      stopCalls++;
      return { stopped: false, wasRunning: false, detail: "not running" };
    },
    resolveComposeBinFn: async () => ({ cmd: "docker", prefix: ["compose"] }),
    composeDownFn: async () => {
      composeDownCalls++;
    },
  } as never);

  assert.equal(composeDownCalls, 1, "local mode must still stop the stack");
  assert.equal(stopCalls, 0, "local mode must not signal a host pid");
});
