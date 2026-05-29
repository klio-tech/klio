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

import { platform } from "node:os";

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

/**
 * The Claude Desktop config directory under a fake HOME, resolved per
 * OS exactly as both the local adapter and the cloud writer do. Lets
 * the desktop test create the dir (so installed() fires) and then read
 * the written config back regardless of platform.
 */
function claudeDesktopDir(home: string): string {
  const p = platform();
  if (p === "darwin") {
    return join(home, "Library", "Application Support", "Claude");
  }
  if (p === "win32") {
    const appData = process.env.APPDATA;
    return appData
      ? join(appData, "Claude")
      : join(home, "AppData", "Roaming", "Claude");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "Claude") : join(home, ".config", "Claude");
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

  // permissions.allow carries the 7 klio tools; the 3 cloud capture
  // hooks are installed pointing at the `klio hook` client.
  const settings = JSON.parse(
    readFileSync(join(home, ".claude", "settings.json"), "utf8"),
  );
  assert.ok(Array.isArray(settings.permissions.allow));
  assert.ok(settings.permissions.allow.includes("mcp__klio__recall"));
  assert.equal(
    settings.hooks.SessionStart[0].hooks[0].command,
    "npx -y @klio-tech/klio hook session-start",
  );
  assert.equal(
    settings.hooks.UserPromptSubmit[0].hooks[0].command,
    "npx -y @klio-tech/klio hook user-prompt",
  );
  assert.equal(
    settings.hooks.Stop[0].hooks[0].command,
    "npx -y @klio-tech/klio hook session-stop",
  );
  // Cloud captures a subset: no Pre/PostToolUse round-trips.
  assert.equal(settings.hooks.PreToolUse, undefined);
  assert.equal(settings.hooks.PostToolUse, undefined);
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

test("opencode is now wired (no longer in the skip list)", async (t) => {
  const home = withFakeHome(t);
  // withFakeHome pins XDG_CONFIG_HOME under the fake home, so
  // OpenCode's installed() check (looks under $XDG_CONFIG_HOME/opencode)
  // is hermetic.
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });

  const { fn } = recordingClaudeCli();
  const lines: string[] = [];
  const result = await wireCloudAgents({
    apiKey: "k",
    agentId: "a",
    log: (l) => lines.push(l),
    claudeCliFn: fn,
  });

  assert.ok(
    result.configured.includes("opencode"),
    "opencode now has a cloud writer",
  );
  assert.deepEqual(result.skipped, [], "no agent left in the skip list");
  assert.doesNotMatch(lines.join("\n"), /opencode.*skipping/i);
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

// ---------------------------------------------------------------------
// Claude Desktop — mcp-remote stdio bridge (no native HTTP-with-headers)
// ---------------------------------------------------------------------

test("Claude Desktop: writes mcp-remote stdio bridge with URL + both headers", async (t) => {
  const home = withFakeHome(t);
  const dir = claudeDesktopDir(home);
  mkdirSync(dir, { recursive: true });

  const result = await wireCloudAgents({
    apiKey: "sk-desk",
    agentId: "klio-desktop",
    log: () => {},
  });

  assert.ok(result.configured.includes("claude-desktop"));

  const body = JSON.parse(
    readFileSync(join(dir, "claude_desktop_config.json"), "utf8"),
  );
  const klio = body.mcpServers.klio;
  assert.equal(klio.command, "npx");
  assert.deepEqual(klio.args, [
    "-y",
    "mcp-remote",
    CLOUD_MCP_URL,
    "--header",
    "X-Vex-Key: sk-desk",
    "--header",
    "X-Vex-Agent: klio-desktop",
  ]);
  // Bridge mode: no native url/headers fields on the entry itself.
  assert.equal(klio.url, undefined);
  assert.equal(klio.headers, undefined);
});

test("Claude Desktop: preserves peer servers and backs up before patching", async (t) => {
  const home = withFakeHome(t);
  const dir = claudeDesktopDir(home);
  mkdirSync(dir, { recursive: true });
  const { writeFileSync, readdirSync } = await import("node:fs");
  writeFileSync(
    join(dir, "claude_desktop_config.json"),
    JSON.stringify({ mcpServers: { fs: { command: "/opt/fs" } } }, null, 2),
  );

  await wireCloudAgents({ apiKey: "k", agentId: "a", log: () => {} });

  const body = JSON.parse(
    readFileSync(join(dir, "claude_desktop_config.json"), "utf8"),
  );
  assert.ok(body.mcpServers.fs, "peer server preserved");
  assert.equal(body.mcpServers.klio.command, "npx");

  const backups = readdirSync(dir).filter((f) =>
    f.startsWith("claude_desktop_config.json.klio-backup-"),
  );
  assert.equal(backups.length, 1, "must back up before patching");
});

// ---------------------------------------------------------------------
// OpenCode — native remote-HTTP MCP (type: "remote")
// ---------------------------------------------------------------------

test("OpenCode: writes native remote MCP entry with url + both headers", async (t) => {
  const home = withFakeHome(t);
  // withFakeHome pins XDG_CONFIG_HOME under the fake home.
  const dir = join(home, ".config", "opencode");
  mkdirSync(dir, { recursive: true });

  const result = await wireCloudAgents({
    apiKey: "sk-oc",
    agentId: "klio-oc",
    log: () => {},
  });

  assert.ok(result.configured.includes("opencode"));

  const body = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  const klio = body.mcp.klio;
  assert.equal(klio.type, "remote");
  assert.equal(klio.url, CLOUD_MCP_URL);
  assert.equal(klio.enabled, true);
  assert.equal(klio.headers["X-Vex-Key"], "sk-oc");
  assert.equal(klio.headers["X-Vex-Agent"], "klio-oc");
  // Native HTTP transport — never a stdio/docker command array.
  assert.equal(klio.command, undefined);
  assert.equal(body["$schema"], "https://opencode.ai/config.json");
});

test("OpenCode: preserves peer servers + $schema and backs up before patching", async (t) => {
  const home = withFakeHome(t);
  const dir = join(home, ".config", "opencode");
  mkdirSync(dir, { recursive: true });
  const { writeFileSync, readdirSync } = await import("node:fs");
  writeFileSync(
    join(dir, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        mcp: { other: { type: "local", command: ["foo"] } },
      },
      null,
      2,
    ),
  );

  await wireCloudAgents({ apiKey: "k", agentId: "a", log: () => {} });

  const body = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.ok(body.mcp.other, "peer server preserved");
  assert.equal(body.mcp.klio.url, CLOUD_MCP_URL);

  const backups = readdirSync(dir).filter((f) =>
    f.startsWith("opencode.json.klio-backup-"),
  );
  assert.equal(backups.length, 1, "must back up before patching");
});

// ---------------------------------------------------------------------
// OpenClaw — mcp-remote stdio bridge (mcp.servers.<name>)
// ---------------------------------------------------------------------

test("OpenClaw: writes mcp-remote stdio bridge under mcp.servers with both headers", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".openclaw"));

  const result = await wireCloudAgents({
    apiKey: "sk-claw",
    agentId: "klio-claw",
    log: () => {},
  });

  assert.ok(result.configured.includes("openclaw"));

  const body = JSON.parse(
    readFileSync(join(home, ".openclaw", "config.json"), "utf8"),
  );
  const klio = body.mcp.servers.klio;
  assert.equal(klio.command, "npx");
  assert.deepEqual(klio.args, [
    "-y",
    "mcp-remote",
    CLOUD_MCP_URL,
    "--header",
    "X-Vex-Key: sk-claw",
    "--header",
    "X-Vex-Agent: klio-claw",
  ]);
});

test("OpenClaw: preserves peer servers and backs up before patching", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".openclaw"));
  const { writeFileSync, readdirSync } = await import("node:fs");
  writeFileSync(
    join(home, ".openclaw", "config.json"),
    JSON.stringify(
      { mcp: { servers: { fs: { command: "docker", args: [] } } } },
      null,
      2,
    ),
  );

  await wireCloudAgents({ apiKey: "k", agentId: "a", log: () => {} });

  const body = JSON.parse(
    readFileSync(join(home, ".openclaw", "config.json"), "utf8"),
  );
  assert.ok(body.mcp.servers.fs, "peer server preserved");
  assert.equal(body.mcp.servers.klio.command, "npx");

  const backups = readdirSync(join(home, ".openclaw")).filter((f) =>
    f.startsWith("config.json.klio-backup-"),
  );
  assert.equal(backups.length, 1, "must back up before patching");
});

// ---------------------------------------------------------------------
// Hooks — strip stale local klio hooks, install the 3 cloud capture hooks
// ---------------------------------------------------------------------

const CLOUD_HOOK_COMMANDS = {
  SessionStart: "npx -y @klio-tech/klio hook session-start",
  UserPromptSubmit: "npx -y @klio-tech/klio hook user-prompt",
  Stop: "npx -y @klio-tech/klio hook session-stop",
};

function assertCloudHooksInstalled(settings: {
  hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
}): void {
  for (const [event, command] of Object.entries(CLOUD_HOOK_COMMANDS)) {
    const blocks = settings.hooks[event];
    assert.ok(blocks, `expected ${event} hook block`);
    assert.ok(
      blocks.some((b) => b.hooks.some((h) => h.command === command)),
      `expected ${event} cloud hook command`,
    );
  }
}

test("Claude Code cloud wiring strips stale local klio hooks, installs cloud hooks, keeps non-klio hooks", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".claude"));
  const { writeFileSync, readdirSync } = await import("node:fs");

  // A settings.json a prior LOCAL `klio init` left behind: six docker
  // klio hooks across several events, plus one unrelated user hook.
  const priorSettings = {
    hooks: {
      SessionStart: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: "docker exec -i klio-bridge klio hook session-start",
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: "Bash|Edit|Write",
          hooks: [
            {
              type: "command",
              command: "docker exec -i klio-bridge klio hook pre-tool",
            },
            // A peer (non-klio) hook sharing the same matcher block.
            { type: "command", command: "/usr/local/bin/my-linter" },
          ],
        },
      ],
      // An entirely non-klio event/block.
      PostToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: "echo hi" }],
        },
      ],
    },
  };
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify(priorSettings, null, 2),
  );

  const { fn } = recordingClaudeCli();
  const result = await wireCloudAgents({
    apiKey: "sk-cc",
    agentId: "klio-mac",
    log: () => {},
    claudeCliFn: fn,
  });

  assert.deepEqual(result.configured, ["claude-code"]);

  const settings = JSON.parse(
    readFileSync(join(home, ".claude", "settings.json"), "utf8"),
  );

  // The stale docker SessionStart hook was stripped; the fresh cloud
  // SessionStart hook replaced it (klio-only block → re-created clean).
  assert.equal(
    settings.hooks.SessionStart[0].hooks[0].command,
    "npx -y @klio-tech/klio hook session-start",
  );
  assert.equal(settings.hooks.SessionStart[0].hooks.length, 1);
  // PreToolUse block kept, but only the non-klio linter survives (cloud
  // does not install a PreToolUse hook).
  const pre = settings.hooks.PreToolUse;
  assert.equal(pre.length, 1);
  assert.equal(pre[0].hooks.length, 1);
  assert.equal(pre[0].hooks[0].command, "/usr/local/bin/my-linter");
  // The unrelated PostToolUse hook is untouched (and not added by cloud).
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, "echo hi");

  // The 3 cloud capture hooks are installed; no DOCKER klio hook survives.
  assertCloudHooksInstalled(settings);
  const serialized = JSON.stringify(settings);
  assert.doesNotMatch(serialized, /docker exec/);
  assert.doesNotMatch(serialized, /klio-bridge/);

  // Allowlist behaviour still intact.
  assert.ok(settings.permissions.allow.includes("mcp__klio__recall"));

  // Backup taken before the patch.
  const backups = readdirSync(join(home, ".claude")).filter((f) =>
    f.startsWith("settings.json.klio-backup-"),
  );
  assert.equal(backups.length, 1, "must back up before patching hooks");
});

test("Claude Code cloud wiring installs cloud hooks alongside non-klio hooks", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".claude"));
  const { writeFileSync } = await import("node:fs");

  const priorSettings = {
    hooks: {
      PostToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: "echo hi" }] },
      ],
    },
  };
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify(priorSettings, null, 2),
  );

  const { fn } = recordingClaudeCli();
  const result = await wireCloudAgents({
    apiKey: "k",
    agentId: "a",
    log: () => {},
    claudeCliFn: fn,
  });

  assert.deepEqual(result.configured, ["claude-code"]);

  const settings = JSON.parse(
    readFileSync(join(home, ".claude", "settings.json"), "utf8"),
  );
  // Non-klio hooks survive intact; the 3 cloud hooks are added.
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, "echo hi");
  assertCloudHooksInstalled(settings);
  assert.ok(settings.permissions.allow.includes("mcp__klio__recall"));
});

test("Claude Code cloud wiring installs the 3 capture hooks on a fresh machine", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".claude"));
  const { fn } = recordingClaudeCli();

  await wireCloudAgents({
    apiKey: "k",
    agentId: "a",
    log: () => {},
    claudeCliFn: fn,
  });

  const settings = JSON.parse(
    readFileSync(join(home, ".claude", "settings.json"), "utf8"),
  );
  // Exactly the 3 cloud capture hooks materialised; no others.
  assertCloudHooksInstalled(settings);
  assert.deepEqual(Object.keys(settings.hooks).sort(), [
    "SessionStart",
    "Stop",
    "UserPromptSubmit",
  ]);
});

test("Claude Code cloud wiring is idempotent across re-runs (no duplicate hooks)", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".claude"));
  const { fn } = recordingClaudeCli();

  // Run cloud wiring twice — the second run must strip the prior cloud
  // hooks (their command contains the `klio hook` marker) before
  // re-installing, converging to exactly one block/hook per event.
  for (let i = 0; i < 2; i++) {
    await wireCloudAgents({ apiKey: "k", agentId: "a", log: () => {}, claudeCliFn: fn });
  }

  const settings = JSON.parse(
    readFileSync(join(home, ".claude", "settings.json"), "utf8"),
  );
  assertCloudHooksInstalled(settings);
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
    assert.equal(settings.hooks[event].length, 1, `${event}: one block`);
    assert.equal(settings.hooks[event][0].hooks.length, 1, `${event}: one hook`);
  }
});
