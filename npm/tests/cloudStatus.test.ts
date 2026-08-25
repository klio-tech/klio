// Tests for the cloud-status collector (src/cloudStatus.ts) that
// `klio status` renders: is a key configured, which config files carry
// it, the masked form, and the last recorded verification result.
//
// Every test builds its own fake home directory and passes it
// explicitly — the collector must never read the developer's real
// configs (see tests/run.mjs for why that rule is written in blood).

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectCloudStatus } from "../src/cloudStatus.js";
import { writeLastVerification } from "../src/cloudConfig.js";

type TestCtx = { after: (fn: () => void) => void };

function makeHome(t: TestCtx): string {
  const home = mkdtempSync(join(tmpdir(), "klio-cloudstatus-test-"));
  t.after(() => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return home;
}

function writeCloudConfigFile(home: string, body: unknown): void {
  mkdirSync(join(home, ".klio"), { recursive: true });
  writeFileSync(
    join(home, ".klio", "config.json"),
    JSON.stringify(body, null, 2),
  );
}

test("unconfigured machine: no key, no files, no verification", (t) => {
  const home = makeHome(t);
  const s = collectCloudStatus(home);
  assert.equal(s.configured, false);
  assert.equal(s.keyMasked, null);
  assert.deepEqual(s.keyFiles, []);
  assert.equal(s.lastVerification, null);
});

test("configured machine reports the config file and the masked key only", (t) => {
  const home = makeHome(t);
  writeCloudConfigFile(home, {
    apiKey: "sk-status-key-4242",
    agentId: "klio-test",
    baseUrl: "https://mcp.klio.tech",
  });

  const s = collectCloudStatus(home);
  assert.equal(s.configured, true);
  assert.equal(s.keyMasked, "••••4242");
  assert.deepEqual(s.keyFiles, [join(home, ".klio", "config.json")]);
  // The full key must never appear anywhere in the status struct.
  assert.doesNotMatch(JSON.stringify(s), /sk-status-key-4242/);
});

test("agent config files carrying the key are listed", (t) => {
  const home = makeHome(t);
  const key = "sk-carried-key-9911";
  writeCloudConfigFile(home, {
    apiKey: key,
    agentId: "klio-test",
    baseUrl: "https://mcp.klio.tech",
  });

  // Cursor carries the key; Codex exists but holds a DIFFERENT key and
  // must not be listed.
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(
    join(home, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        klio: {
          url: "https://mcp.klio.tech/mcp",
          headers: { "X-Vex-Key": key, "X-Vex-Agent": "klio-test/cursor" },
        },
      },
    }),
  );
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(
    join(home, ".codex", "config.toml"),
    '[mcp_servers.klio]\nurl = "https://mcp.klio.tech/mcp"\n' +
      '[mcp_servers.klio.http_headers]\n"X-Vex-Key" = "sk-some-other-key"\n',
  );

  const s = collectCloudStatus(home);
  assert.ok(
    s.keyFiles.includes(join(home, ".cursor", "mcp.json")),
    "cursor config carries the key and must be listed",
  );
  assert.ok(
    !s.keyFiles.includes(join(home, ".codex", "config.toml")),
    "codex holds a different key and must not be listed",
  );
  assert.ok(s.keyFiles.includes(join(home, ".klio", "config.json")));
});

test("last verification result is surfaced when recorded", (t) => {
  const home = makeHome(t);
  writeCloudConfigFile(home, {
    apiKey: "sk-verified-key-7777",
    agentId: "klio-test",
    baseUrl: "https://mcp.klio.tech",
  });
  writeLastVerification(
    { at: "2026-08-25T10:00:00.000Z", ok: true, orgId: "org_abc" },
    join(home, ".klio", "config.json"),
  );

  const s = collectCloudStatus(home);
  assert.ok(s.lastVerification, "recorded verification must surface");
  assert.equal(s.lastVerification!.ok, true);
  assert.equal(s.lastVerification!.orgId, "org_abc");
  assert.equal(s.lastVerification!.at, "2026-08-25T10:00:00.000Z");
});

test("recording a verification preserves the credentials in the file", async (t) => {
  const home = makeHome(t);
  writeCloudConfigFile(home, {
    apiKey: "sk-preserved-key-3131",
    agentId: "klio-test",
    baseUrl: "https://mcp.klio.tech",
  });
  const path = join(home, ".klio", "config.json");
  writeLastVerification({ at: "2026-08-25T11:00:00.000Z", ok: false, detail: "network error" }, path);

  const { readCloudConfig } = await import("../src/cloudConfig.js");
  const cfg = readCloudConfig(path);
  assert.ok(cfg, "credentials must survive a verification write");
  assert.equal(cfg!.apiKey, "sk-preserved-key-3131");

  const s = collectCloudStatus(home);
  assert.equal(s.lastVerification!.ok, false);
  assert.equal(s.lastVerification!.detail, "network error");
});

test("a malformed verification record is reported as absent, not thrown", (t) => {
  const home = makeHome(t);
  writeCloudConfigFile(home, {
    apiKey: "sk-malformed-rec-5555",
    agentId: "klio-test",
    baseUrl: "https://mcp.klio.tech",
    lastVerification: "not-an-object",
  });
  const s = collectCloudStatus(home);
  assert.equal(s.configured, true);
  assert.equal(s.lastVerification, null);
});

// ---------------------------------------------------------------------------
// Human summary rendering (`describeCloud` in src/commands/status.ts)
// ---------------------------------------------------------------------------

test("describeCloud: unconfigured machine points at init", async () => {
  const { describeCloud } = await import("../src/commands/status.js");
  const out = describeCloud({
    configured: false,
    keyMasked: null,
    keyFiles: [],
    lastVerification: null,
  }).join("\n");
  assert.match(out, /no API key configured/);
  assert.match(out, /init --key/);
  assert.match(out, /Last verification: never run/);
});

test("describeCloud: configured machine lists files, masked key, and last result", async () => {
  const { describeCloud } = await import("../src/commands/status.js");
  const out = describeCloud({
    configured: true,
    keyMasked: "••••4242",
    keyFiles: ["/home/x/.klio/config.json", "/home/x/.cursor/mcp.json"],
    lastVerification: {
      at: "2026-08-25T10:00:00.000Z",
      ok: true,
      orgId: "org_abc",
    },
  }).join("\n");
  assert.match(out, /key configured \(••••4242\)/);
  assert.match(out, /\.klio\/config\.json/);
  assert.match(out, /\.cursor\/mcp\.json/);
  assert.match(out, /Last verification: OK at 2026-08-25T10:00:00\.000Z \(org org_abc\)/);
});

test("describeCloud: failed verification is stated with its reason", async () => {
  const { describeCloud } = await import("../src/commands/status.js");
  const out = describeCloud({
    configured: true,
    keyMasked: "••••9999",
    keyFiles: ["/home/x/.klio/config.json"],
    lastVerification: {
      at: "2026-08-25T12:00:00.000Z",
      ok: false,
      detail: "key rejected (HTTP 401)",
    },
  }).join("\n");
  assert.match(out, /Last verification: FAILED at 2026-08-25T12:00:00\.000Z — key rejected \(HTTP 401\)/);
});
