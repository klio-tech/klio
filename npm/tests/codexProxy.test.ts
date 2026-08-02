import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODEX_BASE_URL,
  CODEX_PROVIDER_ID,
  applyCodexProxy,
  readCodexProxy,
  removeCodexProxy,
} from "../src/proxy/codexProxy.js";

function scratch(): { config: string; state: string } {
  const dir = mkdtempSync(join(tmpdir(), "klio-codex-proxy-"));
  return { config: join(dir, "config.toml"), state: join(dir, "proxy-wiring.json") };
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("Codex base URL carries the OpenAI upstream prefix", () => {
  // Load bearing. Codex speaks OpenAI's wire protocol, not Anthropic's.
  // A bare http://localhost:8787 would send every Codex request to
  // api.anthropic.com, where all of them 404 — Codex would be wired and
  // broken, which is worse than Codex being unsupported.
  assert.match(CODEX_BASE_URL, /\/__klio\/upstream\/openai\/v1$/);
});

test("applyCodexProxy writes the provider block and selects it", () => {
  const { config, state } = scratch();
  const result = applyCodexProxy({ configPath: config, statePath: state });

  assert.equal(result.changed, true);
  const body = read(config);
  assert.match(body, new RegExp(`^model_provider = "${CODEX_PROVIDER_ID}"$`, "m"));
  assert.match(body, new RegExp(`\\[model_providers\\.${CODEX_PROVIDER_ID}\\]`));
  assert.match(body, new RegExp(`base_url = "${CODEX_BASE_URL.replace(/[/]/g, "\\/")}"`));
  assert.match(body, /wire_api = "responses"/);
});

test("Codex config never holds an API key", () => {
  // `env_key` NAMES the variable Codex reads the credential from; the
  // credential itself stays in the environment. config.toml is mode
  // 0644 by convention and users paste it into issue reports.
  const { config, state } = scratch();
  applyCodexProxy({ configPath: config, statePath: state });
  const body = read(config);
  assert.match(body, /env_key = "OPENAI_API_KEY"/);
  assert.doesNotMatch(body, /sk-/);
});

test("applyCodexProxy preserves comments, ordering and unrelated tables", () => {
  // The file is hand-edited and holds model defaults, sandbox policy
  // and MCP servers. Round-tripping it through a TOML library would
  // drop comments and reorder keys — so the editor is a line scan that
  // rewrites only the block it owns.
  const { config, state } = scratch();
  const original = `# My Codex config — hand written, do not mangle.
model = "gpt-5-codex"
approval_policy = "on-request"

# A comment that must survive.
[sandbox_workspace_write]
network_access = true

[mcp_servers.klio]
command = "docker"
args = ["exec", "-i", "klio-bridge", "klio-mcp"]

[model_providers.my-own-gateway]
name = "Corp gateway"
base_url = "https://gateway.corp.internal/v1"
`;
  writeFileSync(config, original);

  applyCodexProxy({ configPath: config, statePath: state });

  const body = read(config);
  assert.match(body, /# My Codex config — hand written, do not mangle\./);
  assert.match(body, /# A comment that must survive\./);
  assert.match(body, /model = "gpt-5-codex"/);
  assert.match(body, /approval_policy = "on-request"/);
  assert.match(body, /\[sandbox_workspace_write\]\nnetwork_access = true/);
  assert.match(body, /\[mcp_servers\.klio\]/);
  assert.match(body, /\[model_providers\.my-own-gateway\]/);
  assert.match(body, /base_url = "https:\/\/gateway\.corp\.internal\/v1"/);
});

test("applyCodexProxy is idempotent", () => {
  const { config, state } = scratch();
  applyCodexProxy({ configPath: config, statePath: state });
  const first = read(config);

  const second = applyCodexProxy({ configPath: config, statePath: state });

  assert.equal(second.changed, false);
  assert.equal(read(config), first, "second run must be byte-identical");
});

test("model_provider is written above the first table header", () => {
  // A root key placed after a `[table]` header belongs to that table,
  // not to the root — Codex would silently ignore it and keep using
  // whatever provider it had.
  const { config, state } = scratch();
  writeFileSync(config, `[sandbox_workspace_write]\nnetwork_access = true\n`);

  applyCodexProxy({ configPath: config, statePath: state });

  const body = read(config);
  const providerLine = body.indexOf("model_provider =");
  const firstTable = body.indexOf("[");
  assert.ok(providerLine >= 0 && providerLine < firstTable, "model_provider must precede any table");
});

test("an existing model_provider is taken over, and named in the result", () => {
  // Taking it over is the deliberate choice: Codex writes
  // `model_provider = "openai"` for most users, so declining would
  // leave nearly everyone reporting "Codex wired" while Codex still
  // talked straight to OpenAI. What makes it safe is that the prior
  // value is recorded and `klio uninit` gives it back — asserted by the
  // next test.
  const { config, state } = scratch();
  writeFileSync(
    config,
    `model_provider = "my-own-gateway"\n\n[model_providers.my-own-gateway]\nbase_url = "https://gateway.corp.internal/v1"\n`,
  );

  const result = applyCodexProxy({ configPath: config, statePath: state });

  assert.equal(result.replacedProvider, "my-own-gateway");
  assert.match(read(config), /^model_provider = "klio-proxy"$/m);
  assert.match(read(config), /\[model_providers\.klio-proxy\]/);
  // The user's own provider block is untouched — only the selection moved.
  assert.match(read(config), /\[model_providers\.my-own-gateway\]/);
  assert.match(read(config), /base_url = "https:\/\/gateway\.corp\.internal\/v1"/);
});

test("removeCodexProxy restores the prior selection exactly", () => {
  const { config, state } = scratch();
  writeFileSync(
    config,
    `model_provider = "my-own-gateway"\nmodel = "gpt-5-codex"\n\n[model_providers.my-own-gateway]\nbase_url = "https://gateway.corp.internal/v1"\n`,
  );

  applyCodexProxy({ configPath: config, statePath: state });
  assert.match(read(config), /^model_provider = "klio-proxy"$/m);

  removeCodexProxy({ configPath: config, statePath: state });

  const body = read(config);
  assert.match(body, /^model_provider = "my-own-gateway"$/m);
  assert.doesNotMatch(body, /klio-proxy/);
  assert.match(body, /model = "gpt-5-codex"/);
  assert.match(body, /\[model_providers\.my-own-gateway\]/);
});

test("re-running init keeps the ORIGINAL prior selection recorded", () => {
  // The bug this guards: the second run records "klio-proxy" as the
  // prior value, so uninit "restores" the thing it exists to undo.
  const { config, state } = scratch();
  writeFileSync(config, `model_provider = "my-own-gateway"\n`);

  applyCodexProxy({ configPath: config, statePath: state });
  applyCodexProxy({ configPath: config, statePath: state });
  applyCodexProxy({ configPath: config, statePath: state });

  removeCodexProxy({ configPath: config, statePath: state });

  assert.match(read(config), /^model_provider = "my-own-gateway"$/m);
});

test("removeCodexProxy drops model_provider entirely when there was none", () => {
  const { config, state } = scratch();
  writeFileSync(config, `model = "gpt-5-codex"\n`);

  applyCodexProxy({ configPath: config, statePath: state });
  assert.match(read(config), /model_provider = "klio-proxy"/);

  removeCodexProxy({ configPath: config, statePath: state });

  const body = read(config);
  assert.doesNotMatch(body, /model_provider/);
  assert.doesNotMatch(body, /klio-proxy/);
  assert.match(body, /model = "gpt-5-codex"/);
});

test("uninstall preserves every unrelated byte", () => {
  const { config, state } = scratch();
  const original = `# Keep me.
model = "gpt-5-codex"

[mcp_servers.klio]
command = "docker"
args = ["exec", "-i", "klio-bridge", "klio-mcp"]

[apps.klio]
default_tools_approval_mode = "auto"
`;
  writeFileSync(config, original);

  applyCodexProxy({ configPath: config, statePath: state });
  removeCodexProxy({ configPath: config, statePath: state });

  const body = read(config);
  assert.match(body, /# Keep me\./);
  assert.match(body, /\[mcp_servers\.klio\]\ncommand = "docker"/);
  assert.match(body, /\[apps\.klio\]\ndefault_tools_approval_mode = "auto"/);
  assert.doesNotMatch(body, /klio-proxy/);
});

test("removeCodexProxy is a no-op when the config does not exist", () => {
  const { config, state } = scratch();
  const result = removeCodexProxy({ configPath: config, statePath: state });
  assert.equal(result.changed, false);
  assert.equal(existsSync(config), false);
});

test("a provider whose name merely shares a prefix is not touched", () => {
  // `[model_providers.klio-proxy-staging]` is someone else's provider.
  // Block boundaries are found by exact header match plus a literal
  // "." for sub-tables, so prefix collisions cannot bleed.
  const { config, state } = scratch();
  writeFileSync(
    config,
    `[model_providers.klio-proxy-staging]\nbase_url = "https://staging.example/v1"\n`,
  );

  applyCodexProxy({ configPath: config, statePath: state });
  removeCodexProxy({ configPath: config, statePath: state });

  const body = read(config);
  assert.match(body, /\[model_providers\.klio-proxy-staging\]/);
  assert.match(body, /base_url = "https:\/\/staging\.example\/v1"/);
});

test("readCodexProxy reports the selection and base URL without writing", () => {
  const { config, state } = scratch();
  assert.deepEqual(readCodexProxy(config), { selected: null, baseUrl: null });

  applyCodexProxy({ configPath: config, statePath: state });
  const before = read(config);

  const current = readCodexProxy(config);
  assert.equal(current.selected, CODEX_PROVIDER_ID);
  assert.equal(current.baseUrl, CODEX_BASE_URL);
  assert.equal(read(config), before, "reading must not modify the file");
});

test("a model_provider inside a profile table is not mistaken for the root one", () => {
  // `[profiles.work] model_provider = "x"` belongs to that profile.
  // Reading it as the root selection would make us think the user had
  // chosen a provider when they had not.
  const { config, state } = scratch();
  writeFileSync(config, `model = "gpt-5-codex"\n\n[profiles.work]\nmodel_provider = "azure"\n`);

  const result = applyCodexProxy({ configPath: config, statePath: state });

  assert.equal(
    result.replacedProvider,
    undefined,
    "a profile-scoped selection is not the root selection",
  );
  assert.match(read(config), /^model_provider = "klio-proxy"$/m);
  assert.match(read(config), /\[profiles\.work\]\nmodel_provider = "azure"/);
});
