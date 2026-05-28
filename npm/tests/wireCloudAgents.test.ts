// Tests for cloud-mode agent wiring (src/commands/wireCloudAgents.ts).
//
// Each test redirects HOME to a fresh tmpdir so the adapters'
// `installed()` host-fs checks and the writers' file patches are
// hermetic. The Claude CLI is replaced with a recording stub so no
// subprocess is ever spawned. We assert that each writer emits the
// remote-HTTP MCP shape with BOTH headers and writes NO hooks/docker.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  wireCloudAgents,
  type ClaudeCliFn,
} from "../src/commands/wireCloudAgents.js";
import { CLOUD_MCP_URL } from "../src/cloud.js";

type TestCtx = { after: (fn: () => void) => void };

function withFakeHome(t: TestCtx): string {
  const home = mkdtempSync(join(tmpdir(), "klio-cloud-wire-test-"));
  const prevHome = process.env.HOME;
  const prevUserprofile = process.env.USERPROFILE;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // Pin XDG_CONFIG_HOME under the fake home so OpenCode's detection
  // (which reads $XDG_CONFIG_HOME/opencode) can't pick up a real
  // config from the developer's machine and pollute detection.
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  t.after(() => {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserprofile;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return home;
}

/** A Claude-CLI stub that records every invocation and succeeds. */
function recordingClaudeCli(): {
  fn: ClaudeCliFn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const fn: ClaudeCliFn = async (args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };
  return { fn, calls };
}

test("Cursor: writes remote-HTTP mcp.json with url + both headers, no docker", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".cursor"));

  const result = await wireCloudAgents({
    apiKey: "sk-key-123",
    agentId: "klio-testhost",
    log: () => {},
  });

  assert.deepEqual(result.configured, ["cursor"]);

  const body = JSON.parse(
    readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
  );
  const klio = body.mcpServers.klio;
  assert.equal(klio.url, CLOUD_MCP_URL);
  assert.equal(klio.headers["X-Vex-Key"], "sk-key-123");
  assert.equal(klio.headers["X-Vex-Agent"], "klio-testhost");
  // No stdio/docker fields in cloud mode.
  assert.equal(klio.command, undefined);
  assert.equal(klio.args, undefined);
});

test("Cursor: preserves peer servers and backs up before patching", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".cursor"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    join(home, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { fs: { command: "/opt/fs" } } }, null, 2),
  );

  await wireCloudAgents({
    apiKey: "k",
    agentId: "a",
    log: () => {},
  });

  const body = JSON.parse(
    readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
  );
  assert.ok(body.mcpServers.fs, "peer server preserved");
  assert.equal(body.mcpServers.klio.url, CLOUD_MCP_URL);

  const { readdirSync } = await import("node:fs");
  const backups = readdirSync(join(home, ".cursor")).filter((f) =>
    f.startsWith("mcp.json.klio-backup-"),
  );
  assert.equal(backups.length, 1, "must back up before patching");
});

test("Claude Code: registers HTTP transport via add-json + allowlists tools", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".claude"));
  const { fn, calls } = recordingClaudeCli();

  const result = await wireCloudAgents({
    apiKey: "sk-cc",
    agentId: "klio-mac",
    log: () => {},
    claudeCliFn: fn,
  });

  assert.deepEqual(result.configured, ["claude-code"]);

  // remove-then-add idempotency pair.
  const addJson = calls.find((c) => c[1] === "add-json");
  assert.ok(addJson, "must call claude mcp add-json");
  assert.ok(
    calls.some((c) => c[1] === "remove"),
    "must remove before add for idempotency",
  );

  // The JSON payload is the last add-json arg.
  const payload = JSON.parse(addJson![addJson!.length - 1]);
  assert.equal(payload.type, "http");
  assert.equal(payload.url, CLOUD_MCP_URL);
  assert.equal(payload.headers["X-Vex-Key"], "sk-cc");
  assert.equal(payload.headers["X-Vex-Agent"], "klio-mac");
  // No stdio command/args — this is the HTTP transport.
  assert.equal(payload.command, undefined);

  // permissions.allow carries the 7 klio tools; NO hooks written.
  const settings = JSON.parse(
    readFileSync(join(home, ".claude", "settings.json"), "utf8"),
  );
  assert.ok(Array.isArray(settings.permissions.allow));
  assert.ok(settings.permissions.allow.includes("mcp__klio__recall"));
  assert.equal(settings.hooks, undefined, "cloud mode writes no hooks");
});

test("Claude Code: non-zero add-json exit is reported as an error, not a throw", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".claude"));
  const fn: ClaudeCliFn = async (args) => {
    if (args[1] === "add-json") return { code: 1, stdout: "", stderr: "boom" };
    return { code: 0, stdout: "", stderr: "" };
  };

  const result = await wireCloudAgents({
    apiKey: "k",
    agentId: "a",
    log: () => {},
    claudeCliFn: fn,
  });

  assert.deepEqual(result.configured, []);
  assert.equal(result.errored.length, 1);
  assert.equal(result.errored[0].name, "claude-code");
  assert.match(result.errored[0].message, /boom/);
});

test("Codex: writes remote-HTTP TOML with url + http_headers, no docker", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".codex"));

  const result = await wireCloudAgents({
    apiKey: "sk-codex",
    agentId: "klio-box",
    log: () => {},
  });

  assert.deepEqual(result.configured, ["codex"]);

  const body = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.match(body, /\[mcp_servers\.klio\]/);
  assert.match(body, /url = "https:\/\/mcp\.klio\.tech\/mcp"/);
  assert.match(body, /\[mcp_servers\.klio\.http_headers\]/);
  assert.match(body, /X-Vex-Key = "sk-codex"/);
  assert.match(body, /X-Vex-Agent = "klio-box"/);
  // No stdio/docker exec form in cloud mode.
  assert.doesNotMatch(body, /command = "docker"/);
});

test("detected agent without a cloud writer is skipped cleanly", async (t) => {
  const home = withFakeHome(t);
  // OpenCode is a real adapter with no cloud writer yet. Its
  // installed() checks $XDG_CONFIG_HOME/opencode or ~/.config/opencode.
  // Pin XDG to the fake home so the dev environment can't leak in.
  const prevXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  t.after(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  });
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });

  const { fn } = recordingClaudeCli();
  const lines: string[] = [];
  const result = await wireCloudAgents({
    apiKey: "k",
    agentId: "a",
    log: (l) => lines.push(l),
    claudeCliFn: fn,
  });

  assert.ok(result.skipped.includes("opencode"));
  assert.deepEqual(result.configured, []);
  assert.match(lines.join("\n"), /opencode.*skipping/i);
});

test("no detected agents → empty result, no throw", async (t) => {
  withFakeHome(t);
  const result = await wireCloudAgents({
    apiKey: "k",
    agentId: "a",
    log: () => {},
  });
  assert.deepEqual(result.configured, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.errored, []);
});

test("multiple detected agents all get wired", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".cursor"));
  mkdirSync(join(home, ".codex"));
  const { fn } = recordingClaudeCli();

  const result = await wireCloudAgents({
    apiKey: "k",
    agentId: "a",
    log: () => {},
    claudeCliFn: fn,
  });

  assert.ok(result.configured.includes("cursor"));
  assert.ok(result.configured.includes("codex"));
  assert.equal(existsSync(join(home, ".cursor", "mcp.json")), true);
  assert.equal(existsSync(join(home, ".codex", "config.toml")), true);
});
