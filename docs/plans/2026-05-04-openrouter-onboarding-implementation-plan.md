# OpenRouter Onboarding + Wow Moment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship `@klio-tech/klio@0.2.0` with OpenRouter-default onboarding, validated provider setup, Codex support, a forced wow moment, and community asks.

**Architecture:** All host-facing logic lives in the npm package (TypeScript, zero deps). The Go bridge gains a Codex adapter for parity with the in-repo `klio init` path. Engine config gains optional OpenRouter routing through LiteLLM's existing `openrouter/<model>` prefix. New CLI submodules: `banner`, `prompt`, `openrouter`, `wow`, `community`, `open-url`, `adapters/codex`. Validation is fail-fast and explicit — no silent fallbacks.

**Tech Stack:** Node 20+, TypeScript 5.7, hand-rolled TOML reader (≈80 LOC), Node `fetch`, Go 1.24, `pelletier/go-toml/v2` (Go side), Python 3.12 + LiteLLM (engine).

**Source design:** `docs/plans/2026-05-04-openrouter-onboarding-design.md`

---

## Section 1 — Engine prep (LiteLLM OpenRouter verification)

This unblocks everything: if LiteLLM doesn't actually route embeddings through OpenRouter, the rest of the plan needs a thin wrapper. Verify first.

### Task 1.1: Add `openrouter_api_key` to engine settings

**Files:**
- Modify: `engine/src/klio_engine/config.py`
- Test: `engine/tests/test_config.py` (create if missing)

**Step 1: Write the failing test**

```python
def test_settings_accepts_openrouter_api_key(monkeypatch):
    monkeypatch.setenv("KLIO_OPENROUTER_API_KEY", "sk-or-test")
    monkeypatch.setenv("KLIO_DATABASE_URL", "postgresql+asyncpg://x")
    from klio_engine.config import Settings
    s = Settings()
    assert s.openrouter_api_key == "sk-or-test"

def test_settings_default_openrouter_key_is_none(monkeypatch):
    monkeypatch.setenv("KLIO_DATABASE_URL", "postgresql+asyncpg://x")
    monkeypatch.delenv("KLIO_OPENROUTER_API_KEY", raising=False)
    from klio_engine.config import Settings
    s = Settings()
    assert s.openrouter_api_key is None
```

**Step 2: Run — expect FAIL**

`cd engine && pytest tests/test_config.py -v`
Expected: AttributeError on `openrouter_api_key`.

**Step 3: Implement**

In `engine/src/klio_engine/config.py`, add inside `Settings`:

```python
    openrouter_api_key: str | None = None
```

**Step 4: Run — expect PASS**

`cd engine && pytest tests/test_config.py -v`

**Step 5: Commit**

```bash
git add engine/src/klio_engine/config.py engine/tests/test_config.py
git commit -m "feat(engine): add KLIO_OPENROUTER_API_KEY config"
```

### Task 1.2: Smoke-test LiteLLM OpenRouter embeddings

**Files:**
- Test: `engine/tests/integration/test_openrouter_embedding.py` (create)

**Step 1: Write the test**

```python
import os
import pytest
import litellm

@pytest.mark.skipif(
    not os.getenv("KLIO_TEST_OPENROUTER_KEY"),
    reason="set KLIO_TEST_OPENROUTER_KEY to run; ~$0.000001 per run",
)
def test_litellm_routes_openrouter_embedding():
    """Confirm LiteLLM's openrouter/ prefix works for embeddings.
    If this fails, we need a thin wrapper; see Task 1.3."""
    os.environ["OPENROUTER_API_KEY"] = os.environ["KLIO_TEST_OPENROUTER_KEY"]
    resp = litellm.embedding(
        model="openrouter/openai/text-embedding-3-small",
        input="ok",
    )
    assert resp.data[0]["embedding"]
    assert len(resp.data[0]["embedding"]) == 1536
```

**Step 2: Run with key**

```bash
KLIO_TEST_OPENROUTER_KEY=sk-or-... pytest engine/tests/integration/test_openrouter_embedding.py -v
```

**Step 3: Branch on result**

- ✅ PASSES → no wrapper needed; skip Task 1.3, proceed to Section 2.
- ❌ FAILS with "Unsupported model" or similar → continue to Task 1.3 to add a thin wrapper.

**Step 4: Commit**

```bash
git add engine/tests/integration/
git commit -m "test(engine): smoke-test LiteLLM openrouter embedding routing"
```

### Task 1.3: (Conditional) OpenRouter embedding wrapper

**Skip if Task 1.2 passed.**

**Files:**
- Modify: `engine/src/klio_engine/services/embeddings.py`
- Test: `engine/tests/test_embeddings.py`

**Step 1: Write the failing test** — that calling `embed(text, model="openrouter/openai/text-embedding-3-small")` produces a 1536-dim vector via direct OpenRouter HTTP call (mock httpx).

**Step 2: Implement** the wrapper: detect `openrouter/` prefix, strip it, call `https://openrouter.ai/api/v1/embeddings` directly with httpx, return the embedding vector.

**Step 3: Verify** with the same integration test from 1.2 — should now pass.

**Step 4: Commit** `feat(engine): direct-HTTP fallback for OpenRouter embeddings`.

---

## Section 2 — NPM package: small utilities

Small leaf modules first — easy to test, no ordering dependencies.

### Task 2.1: Banner module

**Files:**
- Create: `npm/src/banner.ts`
- Create: `npm/tests/banner.test.ts`

**Step 1: Write the failing test**

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderBanner } from "../src/banner.js";

test("renderBanner contains the three-bar mark", () => {
  const out = renderBanner("init");
  assert.match(out, /▔▔▔▔▔/);
  assert.match(out, /klio/);
});

test("renderBanner picks subtitle by command", () => {
  assert.match(renderBanner("init"), /memory they share/);
  assert.match(renderBanner("down"), /stopping/);
  assert.match(renderBanner("uninstall"), /removing/);
});

test("renderBanner falls back to neutral subtitle for unknown command", () => {
  const out = renderBanner("status");
  assert.match(out, /klio/);
  assert.doesNotMatch(out, /memory they share/);
});
```

**Step 2: Run — expect FAIL**

```bash
cd npm && npm test 2>&1 | head
```
Expected: cannot find module `../src/banner.js`.

**Step 3: Implement**

```typescript
// npm/src/banner.ts
const SUBTITLES: Record<string, string> = {
  init: "give every AI agent a memory they share",
  down: "stopping the stack — your memories are safe on disk",
  uninstall: "removing Klio — your agent configs are restored",
};

export function renderBanner(command: string): string {
  const subtitle = SUBTITLES[command] ?? "persistent memory for AI agents";
  return [
    "",
    "   ▔▔▔▔▔",
    "     ▔▔▔     klio",
    `   ▔▔▔▔▔     ${subtitle}`,
    "",
  ].join("\n");
}
```

**Step 4: Run — expect PASS**

`cd npm && npm test`

**Step 5: Commit**

```bash
git add npm/src/banner.ts npm/tests/banner.test.ts
git commit -m "feat(npm): banner module with per-command subtitle"
```

### Task 2.2: open-url utility

**Files:**
- Create: `npm/src/openUrl.ts`
- Create: `npm/tests/openUrl.test.ts`

**Step 1: Write the test**

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveOpenCommand } from "../src/openUrl.js";

test("resolveOpenCommand picks open on darwin", () => {
  assert.equal(resolveOpenCommand("darwin"), "open");
});

test("resolveOpenCommand picks start on win32", () => {
  assert.equal(resolveOpenCommand("win32"), "start");
});

test("resolveOpenCommand picks xdg-open on linux", () => {
  assert.equal(resolveOpenCommand("linux"), "xdg-open");
});
```

**Step 2: Run — expect FAIL.**

**Step 3: Implement**

```typescript
// npm/src/openUrl.ts
import { spawn } from "node:child_process";
import { platform } from "node:os";

export function resolveOpenCommand(p: NodeJS.Platform): string {
  if (p === "darwin") return "open";
  if (p === "win32") return "start";
  return "xdg-open";
}

export function openUrl(url: string): void {
  const cmd = resolveOpenCommand(platform());
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}
```

**Step 4: Run — expect PASS.**

**Step 5: Commit**

```bash
git add npm/src/openUrl.ts npm/tests/openUrl.test.ts
git commit -m "feat(npm): cross-platform openUrl helper"
```

### Task 2.3: Prompt module (interactive readline)

**Files:**
- Create: `npm/src/prompt.ts`
- Create: `npm/tests/prompt.test.ts`

The prompt module needs: defaults, masked input for keys, multiline mode for the wow memory, and re-prompting on validation failure.

Tests use a stream-replay pattern: feed predetermined input via a readable stream, capture the prompt's output via a writable stream, assert.

**Step 1: Write the failing tests**

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Readable, Writable } from "node:stream";
import { prompt } from "../src/prompt.js";

function streams(input: string) {
  const stdin = Readable.from([input]);
  const chunks: string[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stdin, stdout, chunks };
}

test("prompt returns the typed value", async () => {
  const { stdin, stdout } = streams("hello\n");
  const result = await prompt({ message: "Name", stdin, stdout });
  assert.equal(result, "hello");
});

test("prompt returns the default when input is empty", async () => {
  const { stdin, stdout } = streams("\n");
  const result = await prompt({
    message: "Model",
    default: "claude-3-5-haiku",
    stdin,
    stdout,
  });
  assert.equal(result, "claude-3-5-haiku");
});

test("prompt re-prompts until validator passes", async () => {
  const { stdin, stdout } = streams("bad\nbetter\n");
  const result = await prompt({
    message: "Word",
    validate: (v) => (v.startsWith("b") && v.length > 3 ? null : "too short"),
    stdin,
    stdout,
  });
  assert.equal(result, "better");
});

test("prompt with mask=true does not echo characters", async () => {
  const { stdin, stdout, chunks } = streams("secret\n");
  const result = await prompt({
    message: "Key",
    mask: true,
    stdin,
    stdout,
  });
  assert.equal(result, "secret");
  // The literal value should never appear in output
  assert.doesNotMatch(chunks.join(""), /secret/);
});
```

**Step 2: Run — expect FAIL.**

**Step 3: Implement** in `npm/src/prompt.ts`:

```typescript
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export type PromptOptions = {
  message: string;
  default?: string;
  validate?: (value: string) => string | null; // null = OK; string = error
  mask?: boolean;
  multiline?: boolean;
  stdin?: Readable;
  stdout?: Writable;
};

export async function prompt(opts: PromptOptions): Promise<string> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const renderQuestion = () => {
    const def = opts.default ? ` [${opts.default}]` : "";
    stdout.write(`    ${opts.message}${def} › `);
  };

  while (true) {
    renderQuestion();
    const value = await readLine(stdin, stdout, opts.mask ?? false);
    const final = value === "" && opts.default ? opts.default : value;
    if (opts.validate) {
      const err = opts.validate(final);
      if (err) {
        stdout.write(`      ✗ ${err}\n`);
        continue;
      }
    }
    if (!final && !opts.default) {
      stdout.write(`      ✗ value required\n`);
      continue;
    }
    return final;
  }
}

function readLine(
  stdin: Readable,
  stdout: Writable,
  mask: boolean,
): Promise<string> {
  return new Promise((resolve) => {
    if (mask) {
      // Masked: read raw, intercept echo
      let buf = "";
      const onData = (chunk: Buffer) => {
        for (const ch of chunk.toString()) {
          if (ch === "\n" || ch === "\r") {
            stdin.off("data", onData);
            stdout.write("\n");
            resolve(buf);
            return;
          }
          if (ch === "") {
            // backspace
            buf = buf.slice(0, -1);
            stdout.write("\b \b");
            continue;
          }
          buf += ch;
          stdout.write("•");
        }
      };
      stdin.on("data", onData);
      return;
    }
    const rl = createInterface({ input: stdin, output: stdout, terminal: false });
    rl.once("line", (line) => {
      rl.close();
      resolve(line);
    });
  });
}
```

**Step 4: Run — expect PASS.**

**Step 5: Commit**

```bash
git add npm/src/prompt.ts npm/tests/prompt.test.ts
git commit -m "feat(npm): interactive prompt with default/mask/validate"
```

---

## Section 3 — NPM package: OpenRouter validation

### Task 3.1: OpenRouter probe functions

**Files:**
- Create: `npm/src/openrouter.ts`
- Create: `npm/tests/openrouter.test.ts`

**Step 1: Write the failing tests** (using `node:test` with `mock`):

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  probeKey,
  probeEmbeddingModel,
  probeChatModel,
} from "../src/openrouter.js";

function mockFetch(handler: (req: Request) => Response | Promise<Response>) {
  // @ts-expect-error override global fetch for the duration of test
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    const req = new Request(...(args as ConstructorParameters<typeof Request>));
    return handler(req);
  };
}

test("probeKey returns metadata on 200", async () => {
  mockFetch(async (req) => {
    assert.equal(req.url, "https://openrouter.ai/api/v1/auth/key");
    assert.equal(req.headers.get("authorization"), "Bearer sk-or-test");
    return new Response(
      JSON.stringify({ data: { label: "test", limit_remaining: 42.13 } }),
      { status: 200 },
    );
  });
  const r = await probeKey("sk-or-test");
  assert.equal(r.label, "test");
  assert.equal(r.creditRemaining, 42.13);
});

test("probeKey throws on 401", async () => {
  mockFetch(async () => new Response("unauthorized", { status: 401 }));
  await assert.rejects(() => probeKey("bad"), /Invalid key/);
});

test("probeEmbeddingModel returns dim on success", async () => {
  mockFetch(async (req) => {
    assert.equal(req.url, "https://openrouter.ai/api/v1/embeddings");
    return new Response(
      JSON.stringify({
        data: [{ embedding: new Array(1536).fill(0) }],
        usage: { total_tokens: 1 },
      }),
      { status: 200 },
    );
  });
  const r = await probeEmbeddingModel("sk-or-test", "openai/text-embedding-3-small");
  assert.equal(r.dim, 1536);
  assert.equal(r.tokensUsed, 1);
});

test("probeEmbeddingModel throws on 404", async () => {
  mockFetch(async () =>
    new Response(JSON.stringify({ error: { message: "Model not found" } }), {
      status: 404,
    }),
  );
  await assert.rejects(
    () => probeEmbeddingModel("k", "made-up/model"),
    /Model not found/,
  );
});

test("probeChatModel returns a response", async () => {
  mockFetch(async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { total_tokens: 4 },
      }),
      { status: 200 },
    ),
  );
  const r = await probeChatModel("k", "anthropic/claude-3-5-haiku");
  assert.ok(r.tokensUsed > 0);
});
```

**Step 2: Run — expect FAIL.**

**Step 3: Implement**

```typescript
// npm/src/openrouter.ts
const BASE = "https://openrouter.ai/api/v1";

export type KeyInfo = { label: string; creditRemaining: number | null };
export type EmbeddingProbe = { dim: number; tokensUsed: number };
export type ChatProbe = { tokensUsed: number; latencyMs: number };

export async function probeKey(key: string): Promise<KeyInfo> {
  const res = await fetch(`${BASE}/auth/key`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (res.status === 401) throw new Error("Invalid key");
  if (res.status === 402) throw new Error("Out of credit on this key");
  if (!res.ok) throw new Error(`OpenRouter unreachable (HTTP ${res.status})`);
  const body = (await res.json()) as {
    data: { label: string; limit_remaining: number | null };
  };
  return {
    label: body.data.label,
    creditRemaining: body.data.limit_remaining,
  };
}

export async function probeEmbeddingModel(
  key: string,
  model: string,
): Promise<EmbeddingProbe> {
  const res = await fetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: "ok" }),
  });
  const body = (await res.json()) as
    | { data: { embedding: number[] }[]; usage?: { total_tokens?: number } }
    | { error?: { message?: string } };
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } }).error?.message;
    throw new Error(msg ?? `Model probe failed (HTTP ${res.status})`);
  }
  const data = (body as { data: { embedding: number[] }[] }).data;
  if (!data?.[0]?.embedding) {
    throw new Error("Unexpected response shape from /embeddings");
  }
  return {
    dim: data[0].embedding.length,
    tokensUsed: (body as { usage?: { total_tokens?: number } }).usage?.total_tokens ?? 0,
  };
}

export async function probeChatModel(
  key: string,
  model: string,
): Promise<ChatProbe> {
  const start = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "ok" }],
      max_tokens: 1,
    }),
  });
  const body = (await res.json()) as
    | { choices: { message: { content: string } }[]; usage?: { total_tokens?: number } }
    | { error?: { message?: string } };
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } }).error?.message;
    throw new Error(msg ?? `Model probe failed (HTTP ${res.status})`);
  }
  return {
    tokensUsed: (body as { usage?: { total_tokens?: number } }).usage?.total_tokens ?? 0,
    latencyMs: Date.now() - start,
  };
}
```

**Step 4: Run — expect PASS.**

**Step 5: Commit**

```bash
git add npm/src/openrouter.ts npm/tests/openrouter.test.ts
git commit -m "feat(npm): OpenRouter key/embedding/chat probes"
```

### Task 3.2: Provider setup orchestrator

**Files:**
- Create: `npm/src/providerSetup.ts`
- Create: `npm/tests/providerSetup.test.ts`

This wires `prompt` + `openrouter` into the three-step interactive setup. Returns a `ProviderConfig` object the init flow writes to `~/.klio/runtime/.env`.

**Step 1: Write the test** (mocks both `prompt` and the openrouter probes via dependency injection):

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { setupProvider } from "../src/providerSetup.js";

test("setupProvider returns key + models when all probes pass", async () => {
  const inputs = ["sk-or-test", "openai/text-embedding-3-small", "anthropic/claude-3-5-haiku"];
  let i = 0;
  const cfg = await setupProvider({
    promptFn: async () => inputs[i++],
    probeKey: async () => ({ label: "test", creditRemaining: 42 }),
    probeEmbedding: async () => ({ dim: 1536, tokensUsed: 1 }),
    probeChat: async () => ({ tokensUsed: 1, latencyMs: 200 }),
    log: () => {},
  });
  assert.equal(cfg.openrouterKey, "sk-or-test");
  assert.equal(cfg.embeddingModel, "openai/text-embedding-3-small");
  assert.equal(cfg.extractionModel, "anthropic/claude-3-5-haiku");
  assert.equal(cfg.embeddingDim, 1536);
});

test("setupProvider re-prompts on key probe failure", async () => {
  const inputs = ["bad", "sk-or-good", "openai/text-embedding-3-small", "anthropic/claude-3-5-haiku"];
  let i = 0;
  let probeCalls = 0;
  await setupProvider({
    promptFn: async () => inputs[i++],
    probeKey: async (k) => {
      probeCalls++;
      if (k === "bad") throw new Error("Invalid key");
      return { label: "ok", creditRemaining: 1 };
    },
    probeEmbedding: async () => ({ dim: 1536, tokensUsed: 1 }),
    probeChat: async () => ({ tokensUsed: 1, latencyMs: 200 }),
    log: () => {},
  });
  assert.equal(probeCalls, 2);
});
```

**Step 2: Run — expect FAIL.**

**Step 3: Implement**

```typescript
// npm/src/providerSetup.ts
export type ProviderConfig = {
  openrouterKey: string;
  embeddingModel: string;
  embeddingDim: number;
  extractionModel: string;
  totalTestTokens: number;
};

export type SetupDeps = {
  promptFn: (opts: { message: string; default?: string; mask?: boolean }) => Promise<string>;
  probeKey: (key: string) => Promise<{ label: string; creditRemaining: number | null }>;
  probeEmbedding: (key: string, model: string) => Promise<{ dim: number; tokensUsed: number }>;
  probeChat: (key: string, model: string) => Promise<{ tokensUsed: number; latencyMs: number }>;
  log: (line: string) => void;
};

const DEFAULT_EMBED = "openai/text-embedding-3-small";
const DEFAULT_CHAT = "anthropic/claude-3-5-haiku";

export async function setupProvider(deps: SetupDeps): Promise<ProviderConfig> {
  // Key
  let keyInfo;
  let key = "";
  while (true) {
    key = await deps.promptFn({ message: "OpenRouter API key", mask: true });
    try {
      keyInfo = await deps.probeKey(key);
      deps.log(
        `      ✓ Valid · ${keyInfo.label}` +
          (keyInfo.creditRemaining !== null
            ? ` · $${keyInfo.creditRemaining.toFixed(2)} credit available`
            : ""),
      );
      break;
    } catch (err) {
      deps.log(`      ✗ ${(err as Error).message}`);
    }
  }

  // Embedding
  let embedRes;
  let embedModel = "";
  while (true) {
    embedModel = await deps.promptFn({ message: "Embedding model", default: DEFAULT_EMBED });
    try {
      embedRes = await deps.probeEmbedding(key, embedModel);
      deps.log(`      ✓ ${embedRes.dim}-dim, ${embedRes.tokensUsed} test token(s)`);
      break;
    } catch (err) {
      deps.log(`      ✗ ${(err as Error).message}`);
    }
  }

  // Chat
  let chatRes;
  let chatModel = "";
  while (true) {
    chatModel = await deps.promptFn({ message: "Extraction model", default: DEFAULT_CHAT });
    try {
      chatRes = await deps.probeChat(key, chatModel);
      deps.log(`      ✓ responded in ${chatRes.latencyMs}ms, ${chatRes.tokensUsed} test token(s)`);
      break;
    } catch (err) {
      deps.log(`      ✗ ${(err as Error).message}`);
    }
  }

  return {
    openrouterKey: key,
    embeddingModel: embedModel,
    embeddingDim: embedRes.dim,
    extractionModel: chatModel,
    totalTestTokens: embedRes.tokensUsed + chatRes.tokensUsed,
  };
}
```

**Step 4: Run — expect PASS.**

**Step 5: Commit**

```bash
git add npm/src/providerSetup.ts npm/tests/providerSetup.test.ts
git commit -m "feat(npm): interactive OpenRouter provider setup with retry"
```

---

## Section 4 — NPM package: Codex adapter

### Task 4.1: Hand-rolled TOML for the Codex subset

**Files:**
- Create: `npm/src/adapters/toml.ts`
- Create: `npm/tests/toml.test.ts`

We only need to support the limited subset Codex's MCP config uses: top-level tables, dotted-key tables (`[mcp_servers.klio]`), nested env tables, scalar values, string arrays. Reject anything we don't understand by leaving it untouched in the source string.

**Step 1: Write the failing tests**

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { upsertMcpServer, parseMcpServers } from "../src/adapters/toml.js";

test("upsertMcpServer adds a klio server to an empty config", () => {
  const out = upsertMcpServer("", "klio", {
    command: "docker",
    args: ["exec", "-i", "klio-bridge", "klio-mcp"],
    env: { KLIO_DOCKER_BRIDGE: "klio-bridge" },
  });
  assert.match(out, /\[mcp_servers\.klio\]/);
  assert.match(out, /command = "docker"/);
  assert.match(out, /args = \["exec", "-i", "klio-bridge", "klio-mcp"\]/);
  assert.match(out, /\[mcp_servers\.klio\.env\]/);
  assert.match(out, /KLIO_DOCKER_BRIDGE = "klio-bridge"/);
});

test("upsertMcpServer replaces an existing klio server but keeps peers", () => {
  const original = `
[mcp_servers.filesystem]
command = "/opt/fs"

[mcp_servers.klio]
command = "/old/path"

[other_section]
key = "value"
`;
  const out = upsertMcpServer(original, "klio", {
    command: "docker",
    args: [],
    env: {},
  });
  assert.match(out, /command = "\/opt\/fs"/);
  assert.match(out, /command = "docker"/);
  assert.doesNotMatch(out, /\/old\/path/);
  assert.match(out, /\[other_section\]/);
});

test("parseMcpServers returns the names present", () => {
  const names = parseMcpServers(`
[mcp_servers.fs]
command = "/x"

[mcp_servers.klio]
command = "/y"
`);
  assert.deepEqual([...names].sort(), ["fs", "klio"]);
});
```

**Step 2: Run — expect FAIL.**

**Step 3: Implement** in `npm/src/adapters/toml.ts`:

```typescript
export type McpServerEntry = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

const HEADER_PREFIX = "[mcp_servers.";
const ENV_HEADER_PREFIX = "[mcp_servers.";

/**
 * Walk a TOML body line-by-line, locate the [mcp_servers.<name>] block
 * (and any [mcp_servers.<name>.env] continuation), and return the
 * source slice that owns it. Block ends at the next top-level [..]
 * header that doesn't start with `mcp_servers.<name>`.
 */
function findBlockRange(
  body: string,
  name: string,
): { start: number; end: number } | null {
  const lines = body.split("\n");
  const header = `[mcp_servers.${name}]`;
  const envHeader = `[mcp_servers.${name}.env]`;
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === header) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) return null;
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (
      t.startsWith("[") &&
      !t.startsWith(envHeader.slice(0, envHeader.length - 1))
    ) {
      endLine = i;
      break;
    }
  }
  // Convert line indices to character offsets.
  const start = lines.slice(0, startLine).reduce((a, l) => a + l.length + 1, 0);
  const end = lines.slice(0, endLine).reduce((a, l) => a + l.length + 1, 0);
  return { start, end };
}

function renderEntry(name: string, entry: McpServerEntry): string {
  const lines = [`[mcp_servers.${name}]`];
  lines.push(`command = ${JSON.stringify(entry.command)}`);
  lines.push(
    `args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]`,
  );
  const env = entry.env ?? {};
  if (Object.keys(env).length > 0) {
    lines.push("");
    lines.push(`[mcp_servers.${name}.env]`);
    for (const [k, v] of Object.entries(env)) {
      lines.push(`${k} = ${JSON.stringify(v)}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function upsertMcpServer(
  body: string,
  name: string,
  entry: McpServerEntry,
): string {
  const range = findBlockRange(body, name);
  const rendered = renderEntry(name, entry);
  if (!range) {
    const sep = body.length === 0 || body.endsWith("\n") ? "" : "\n";
    return body + sep + (body.length > 0 ? "\n" : "") + rendered;
  }
  return body.slice(0, range.start) + rendered + body.slice(range.end);
}

export function parseMcpServers(body: string): Set<string> {
  const out = new Set<string>();
  for (const raw of body.split("\n")) {
    const t = raw.trim();
    if (!t.startsWith(HEADER_PREFIX) || !t.endsWith("]")) continue;
    const inside = t.slice(HEADER_PREFIX.length, -1);
    if (inside.includes(".")) continue; // skip the .env subtable header
    out.add(inside);
  }
  return out;
}

export function removeMcpServer(body: string, name: string): string {
  const range = findBlockRange(body, name);
  if (!range) return body;
  return body.slice(0, range.start) + body.slice(range.end);
}
```

**Step 4: Run — expect PASS.**

**Step 5: Commit**

```bash
git add npm/src/adapters/toml.ts npm/tests/toml.test.ts
git commit -m "feat(npm): minimal TOML reader/writer for Codex MCP config"
```

### Task 4.2: Codex adapter

**Files:**
- Create: `npm/src/adapters/codex.ts`
- Create: `npm/tests/codex.test.ts`

**Step 1: Write the failing tests** — same shape as the Cursor adapter tests: detect, install, peer-preserve, idempotent re-install, uninstall restore, uninstall strip when no backup.

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";

function withFakeHome(t: any) {
  const tmp = `/tmp/klio-codex-test-${Date.now()}-${Math.random()}`;
  mkdirSync(tmp);
  const old = process.env.HOME;
  process.env.HOME = tmp;
  t.after(() => {
    process.env.HOME = old;
  });
  return tmp;
}

test("CodexAdapter not installed when ~/.codex absent", (t) => {
  withFakeHome(t);
  assert.equal(new CodexAdapter().installed(), false);
});

test("CodexAdapter installed when ~/.codex exists", (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".codex"));
  assert.equal(new CodexAdapter().installed(), true);
});

test("CodexAdapter.install creates config with klio entry", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".codex"));
  await new CodexAdapter().install({
    bridgeContainer: "klio-bridge",
    env: { K: "V" },
  });
  const body = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.match(body, /\[mcp_servers\.klio\]/);
  assert.match(body, /command = "docker"/);
  assert.match(body, /K = "V"/);
});

test("CodexAdapter.install preserves peer servers", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".codex"));
  writeFileSync(
    join(home, ".codex", "config.toml"),
    `[mcp_servers.fs]
command = "/opt/fs"
args = []
`,
  );
  await new CodexAdapter().install({
    bridgeContainer: "klio-bridge",
    env: {},
  });
  const body = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.match(body, /command = "\/opt\/fs"/);
  assert.match(body, /\[mcp_servers\.klio\]/);
});

test("CodexAdapter.install is idempotent", async (t) => {
  const home = withFakeHome(t);
  mkdirSync(join(home, ".codex"));
  const a = new CodexAdapter();
  await a.install({ bridgeContainer: "klio-bridge", env: { K: "V" } });
  const first = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  await a.install({ bridgeContainer: "klio-bridge", env: { K: "V" } });
  const second = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.equal(first, second);
});
```

**Step 2: Run — expect FAIL.**

**Step 3: Implement**

```typescript
// npm/src/adapters/codex.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Adapter, AdapterConfig } from "./types.js";
import { backupFile, restoreFromBackup } from "./fileutil.js";
import { upsertMcpServer, removeMcpServer } from "./toml.js";

export class CodexAdapter implements Adapter {
  name(): string {
    return "codex";
  }

  private configPath(): string {
    return join(homedir(), ".codex", "config.toml");
  }

  installed(): boolean {
    return existsSync(join(homedir(), ".codex"));
  }

  async install(cfg: AdapterConfig): Promise<void> {
    const path = this.configPath();
    const prior = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (existsSync(path)) backupFile(path);

    const next = upsertMcpServer(prior, "klio", {
      command: "docker",
      args: ["exec", "-i", cfg.bridgeContainer, "klio-mcp"],
      env: cfg.env,
    });
    writeFileSync(path, next, { mode: 0o644 });
  }

  async uninstall(): Promise<void> {
    const path = this.configPath();
    if (!existsSync(path)) return;
    try {
      restoreFromBackup(path);
      return;
    } catch {
      // No backup — strip in place.
    }
    const stripped = removeMcpServer(readFileSync(path, "utf8"), "klio");
    writeFileSync(path, stripped, { mode: 0o644 });
  }
}
```

**Step 4: Add Codex to the adapter list**

Modify `npm/src/adapters/types.ts` to export an `allAdapters()` function (if it doesn't already):

```typescript
import { ClaudeCodeAdapter } from "./claudeCode.js";
import { CursorAdapter } from "./cursor.js";
import { CodexAdapter } from "./codex.js";

export function allAdapters(): Adapter[] {
  return [new ClaudeCodeAdapter(), new CursorAdapter(), new CodexAdapter()];
}
```

(Or if `init.ts` instantiates adapters inline, add `new CodexAdapter()` there.)

**Step 5: Run — expect PASS.**

**Step 6: Commit**

```bash
git add npm/src/adapters/codex.ts npm/tests/codex.test.ts npm/src/adapters/types.ts
git commit -m "feat(npm): Codex MCP adapter (TOML)"
```

---

## Section 5 — NPM package: wow moment + community asks

### Task 5.1: Wow moment module

**Files:**
- Create: `npm/src/wow.ts`
- Create: `npm/tests/wow.test.ts`

**Step 1: Write the failing test**

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runWowMoment } from "../src/wow.js";

test("runWowMoment posts the memory and validates recall", async () => {
  const calls: { url: string; body?: unknown }[] = [];
  const mockFetch: typeof fetch = async (url, init) => {
    calls.push({ url: url.toString(), body: init?.body && JSON.parse(init.body as string) });
    if (url.toString().endsWith("/v1/entries")) {
      return new Response(JSON.stringify({ id: "7a2c-fake" }), { status: 201 });
    }
    return new Response(
      JSON.stringify({
        results: [{ id: "7a2c-fake", content: "I'm Abhishek", score: 0.92 }],
      }),
      { status: 200 },
    );
  };
  const result = await runWowMoment({
    engineURL: "http://localhost:8000",
    refreshToken: "rt",
    spaceID: "space-id",
    promptFn: async () => "I'm Abhishek, building Klio",
    log: () => {},
    waitEnter: async () => {},
    fetchFn: mockFetch,
  });
  assert.equal(result.entryID, "7a2c-fake");
  assert.equal(result.recallScore, 0.92);
  assert.equal(calls.length, 2);
});
```

**Step 2: Run — expect FAIL.**

**Step 3: Implement**

```typescript
// npm/src/wow.ts
export type WowDeps = {
  engineURL: string;
  refreshToken: string;
  spaceID: string;
  promptFn: (opts: { message: string; multiline?: boolean }) => Promise<string>;
  log: (line: string) => void;
  waitEnter: () => Promise<void>;
  fetchFn?: typeof fetch;
};

export type WowResult = { entryID: string; recallScore: number };

export async function runWowMoment(deps: WowDeps): Promise<WowResult> {
  const f = deps.fetchFn ?? fetch;
  const memory = await deps.promptFn({
    message: "Your memory",
    multiline: true,
  });

  const writeRes = await f(`${deps.engineURL}/v1/entries`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${deps.refreshToken}`,
    },
    body: JSON.stringify({
      space_id: deps.spaceID,
      kind: "preference",
      content: memory,
      metadata: { source: "klio init wow moment" },
      confidence: 1.0,
    }),
  });
  if (!writeRes.ok) throw new Error(`store memory failed (HTTP ${writeRes.status})`);
  const writeBody = (await writeRes.json()) as { id: string };
  deps.log(`      ✓ stored as fact (id: ${writeBody.id.slice(0, 8)}…)`);

  const recallRes = await f(
    `${deps.engineURL}/v1/spaces/${deps.spaceID}/recall`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deps.refreshToken}`,
      },
      body: JSON.stringify({
        query: "what should you remember about me",
        limit: 1,
      }),
    },
  );
  const recallBody = (await recallRes.json()) as {
    results: { id: string; score: number }[];
  };
  const top = recallBody.results?.[0];
  if (!top || top.id !== writeBody.id) {
    deps.log("      ! recall returned a different top entry — proceeding anyway");
  } else {
    deps.log(`      ✓ found, score ${top.score.toFixed(2)}`);
  }

  deps.log("");
  deps.log("───────────────────────────────────────────────────────");
  deps.log("🪄 Now open Claude Code in any project and ask:");
  deps.log("");
  deps.log('       "What do you know about me?"');
  deps.log("");
  deps.log(
    "    Claude will use the klio recall tool and tell you back exactly",
  );
  deps.log("    what you just typed.");
  deps.log("");
  deps.log("    [press enter when you've seen it work, or ctrl-c if it didn't]");
  await deps.waitEnter();
  deps.log("");
  deps.log("    ✓ Confirmed.");

  return {
    entryID: writeBody.id,
    recallScore: top?.score ?? 0,
  };
}
```

**Step 4: Run — expect PASS.**

**Step 5: Commit**

```bash
git add npm/src/wow.ts npm/tests/wow.test.ts
git commit -m "feat(npm): forced wow moment — write memory + verify recall"
```

### Task 5.2: Community asks module

**Files:**
- Create: `npm/src/community.ts`
- Create: `npm/tests/community.test.ts`

**Step 1: Write the failing test**

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runCommunityAsks } from "../src/community.js";

test("opens both URLs when user accepts both", async () => {
  const opened: string[] = [];
  await runCommunityAsks({
    promptFn: async ({ default: d }) => d ?? "",  // simulate enter on default Y
    openUrlFn: (u) => opened.push(u),
    log: () => {},
  });
  assert.deepEqual(opened, [
    "https://github.com/klio-tech/klio",
    "https://discord.gg/xRRPnW3fN2",
  ]);
});

test("skips both when user declines both", async () => {
  const opened: string[] = [];
  await runCommunityAsks({
    promptFn: async () => "n",
    openUrlFn: (u) => opened.push(u),
    log: () => {},
  });
  assert.equal(opened.length, 0);
});
```

**Step 2: Run — expect FAIL.**

**Step 3: Implement**

```typescript
// npm/src/community.ts
const REPO_URL = "https://github.com/klio-tech/klio";
const DISCORD_URL = "https://discord.gg/xRRPnW3fN2";

export type CommunityDeps = {
  promptFn: (opts: { message: string; default?: string }) => Promise<string>;
  openUrlFn: (url: string) => void;
  log: (line: string) => void;
};

function isYes(answer: string): boolean {
  const t = answer.trim().toLowerCase();
  return t === "" || t === "y" || t === "yes";
}

export async function runCommunityAsks(deps: CommunityDeps): Promise<void> {
  deps.log("");
  deps.log(
    "Klio is open-source and community-built. If this saved you even",
  );
  deps.log("an ounce of friction:");
  deps.log("");

  const star = await deps.promptFn({
    message: "Star us on GitHub?",
    default: "Y",
  });
  if (isYes(star)) {
    deps.openUrlFn(REPO_URL);
    deps.log(`      ✓ opened ${REPO_URL.replace(/^https:\/\//, "")} in your browser`);
  }

  const discord = await deps.promptFn({
    message: "Join the Discord?",
    default: "Y",
  });
  if (isYes(discord)) {
    deps.openUrlFn(DISCORD_URL);
    deps.log(
      `      ✓ opened ${DISCORD_URL.replace(/^https:\/\//, "")} in your browser`,
    );
  }
}
```

**Step 4: Run — expect PASS.**

**Step 5: Commit**

```bash
git add npm/src/community.ts npm/tests/community.test.ts
git commit -m "feat(npm): community asks (star + Discord) at end of init"
```

---

## Section 6 — NPM package: compose template + init refactor

### Task 6.1: Add OpenRouter env vars to compose template

**Files:**
- Modify: `npm/src/compose.ts`
- Modify: `npm/tests/compose.test.ts` (create if missing)

**Step 1: Write the failing test**

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderComposeBody } from "../src/compose.js";

test("compose body includes OPENROUTER_API_KEY env var", () => {
  const body = renderComposeBody({
    imageTag: "0.2.0",
    jwtSigningKey: "k",
    embeddingModel: "openrouter/openai/text-embedding-3-small",
    extractionModel: "openrouter/anthropic/claude-3-5-haiku",
  });
  assert.match(body, /KLIO_OPENROUTER_API_KEY/);
  assert.match(body, /openrouter\/openai\/text-embedding-3-small/);
});
```

**Step 2: Run — expect FAIL.**

**Step 3: Implement** — extract `renderCompose` into `renderComposeBody` (export), thread `embeddingModel`, `extractionModel`, plus add the env vars in the engine service:

```yaml
      KLIO_OPENROUTER_API_KEY: ${KLIO_OPENROUTER_API_KEY}
      KLIO_EMBEDDING_MODEL: <embeddingModel>
      KLIO_EXTRACTION_MODEL: <extractionModel>
      OPENROUTER_API_KEY: ${KLIO_OPENROUTER_API_KEY}  # LiteLLM convention
```

**Step 4: Run — expect PASS.**

**Step 5: Commit**

```bash
git add npm/src/compose.ts npm/tests/compose.test.ts
git commit -m "feat(npm): compose template plumbs OpenRouter key + models"
```

### Task 6.2: Rewrite `init.ts` to use the new orchestration

**Files:**
- Modify: `npm/src/commands/init.ts` (rewrite)
- Test: `npm/tests/init.test.ts` (smoke test that the function compiles + accepts the new options shape; full E2E happens in Section 8)

This task is sequential — wire all the new pieces in the right order:

1. Print banner
2. Docker preflight
3. Compose pull
4. Compose up postgres + redis + engine + bridge
5. Wait engine /health
6. **Provider setup** (key, embedding, chat) — NEW
7. Provision account
8. **Detect agents + show found list + confirm** — UPDATED
9. Configure bridge keychain
10. Wire detected adapters
11. **Wow moment** — NEW
12. **Community asks** — NEW
13. Compose up trust-app
14. Print final reference block

Use the new `setupProvider`, `runWowMoment`, `runCommunityAsks` modules.

**Steps:** Write a smoke test that init.ts exports `init(opts)`, run/fail, write the rewrite, run/pass, commit.

```bash
git add npm/src/commands/init.ts npm/tests/init.test.ts
git commit -m "feat(npm): rewrite init flow — provider + wow + community"
```

---

## Section 7 — Bridge (Go): Codex adapter

### Task 7.1: Add `pelletier/go-toml/v2` dependency

```bash
cd bridge && go get github.com/pelletier/go-toml/v2 && go mod tidy
git add bridge/go.mod bridge/go.sum
git commit -m "deps(bridge): add pelletier/go-toml/v2 for Codex adapter"
```

### Task 7.2: Codex adapter (Go)

**Files:**
- Create: `bridge/internal/agentadapters/codex.go`
- Create: `bridge/internal/agentadapters/codex_test.go`

**Step 1:** Write tests mirroring `cursor_test.go`: detection, install, peer-preserve, idempotent, uninstall-restore.

**Step 2:** Run — expect FAIL.

**Step 3:** Implement. Use `toml.Unmarshal`/`toml.Marshal` round-trip but careful about preserving non-klio tables. Easiest path: read with `toml.Unmarshal` into `map[string]any`, mutate the `mcp_servers` sub-map, write back with `toml.Marshal`.

**Step 4:** Run — expect PASS. Add to `agentadapters.All()`.

**Step 5:** Commit `feat(bridge): Codex adapter for parity with npm path`.

---

## Section 8 — End-to-end + ship

### Task 8.1: End-to-end smoke test (manual)

**Steps:**

1. Stop existing dev/runtime stacks: `docker compose down -v` in repo + at `~/.klio/runtime/`.
2. Wipe `~/.klio/runtime/` and any agent backups for a clean slate.
3. Build npm package locally: `cd npm && npm run build`.
4. Run `node bin/klio.mjs init` (use a real OpenRouter key).
5. Verify every step displays correctly: banner → docker preflight → pull → up → engine wait → provider (3 prompts validated live) → tool detection (Claude Code, Cursor, Codex if installed) → confirm Y → wire → wow moment (memory typed, recall verified) → community (Y, Y) → trust-app up.
6. Open Claude Code, ask "what do you know about me?", verify recall surfaces the typed memory.
7. Close Claude Code, open new session, repeat — verify persistence.

**No commit yet — this is verification.**

### Task 8.2: Bump to 0.2.0

```bash
cd npm
node -e "const p=require('./package.json'); p.version='0.2.0'; require('fs').writeFileSync('./package.json', JSON.stringify(p, null, 2) + '\n')"
npm install --package-lock-only --no-fund --no-audit
cd ..
git add npm/package.json npm/package-lock.json
git commit -m "chore(npm): release 0.2.0 — OpenRouter onboarding + wow moment"
git push
```

CI publishes:
- `@klio-tech/klio@0.2.0` to npm
- `ghcr.io/klio-tech/klio-{engine,bridge,trust-app}:0.2.0` and `:latest`

### Task 8.3: Public-world smoke test

From a fresh terminal anywhere:

```bash
npx @klio-tech/klio@0.2.0 init
```

Run the full flow against the *published* artifacts. If it succeeds, ship — tweet, post on HN, etc.

---

## Closing notes

- **Tests:** every TS module has a sibling `*.test.ts` using `node:test`. Run all with `npm test` from the `npm/` directory.
- **Coverage target:** 80% line coverage on new modules. Existing modules (compose, docker, ui) stay where they are.
- **Rollback:** if anything regresses, `npm publish @klio-tech/klio@0.1.1` is a known-good fallback the user can pin to. Keep the 0.1.x line working.
- **Skill follow-up:** for executing this plan task-by-task with code review between tasks, use `superpowers:subagent-driven-development`. For batch execution in a fresh session, use `superpowers:executing-plans`.
