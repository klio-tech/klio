# Immersive Onboarding + Drop LiteLLM Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship `@klio-tech/klio@0.3.0` with a guided five-phase onboarding (provider menu, live model catalog, friendly Ollama path, custom-endpoint support) and replace LiteLLM with direct httpx calls in the engine.

**Architecture:** All host-facing UX lives in the npm package (TypeScript, zero runtime deps). The engine routes embeddings + chat calls by model-name prefix (`openrouter/`, `ollama/`, `custom/`, `stub`) and sends OpenRouter attribution headers (`X-Title: Klio`, `HTTP-Referer: https://klio.tech`) on every outbound call. `npm/src/{providerMenu,ollama,customEndpoint}.ts` and `engine/src/klio_engine/services/{embeddings,extractor}.py` are the central touchpoints.

**Tech Stack:** Node 20+, TypeScript 5.7, `node:test`, `httpx` (Python), `pelletier/go-toml/v2` (no Go changes this release), pydantic-settings, pytest.

**Source design:** `docs/plans/2026-05-04-immersive-onboarding-design.md`

**Branch + push policy:** Work on `feat/immersive-onboarding`. **Do not push to GitHub** — commit locally only until the user approves.

---

## Section A — Engine: drop LiteLLM, route by prefix

The engine work unblocks the rest of the plan: once `openrouter/` and `custom/` prefixes work via direct httpx, the npm side can wire users to either path without provider-specific engine logic.

### Task A1: Add `custom_base_url` + `custom_api_key` to Settings

**Files:**
- Modify: `engine/src/klio_engine/config.py:34-36`
- Test: `engine/tests/test_config.py`

**Step 1: Write the failing test (append to test_config.py)**

```python
def test_settings_accepts_custom_endpoint_fields(monkeypatch):
    monkeypatch.setenv("KLIO_DATABASE_URL", "postgresql+asyncpg://x")
    monkeypatch.setenv("KLIO_CUSTOM_BASE_URL", "https://litellm.acme.corp/v1")
    monkeypatch.setenv("KLIO_CUSTOM_API_KEY", "sk-test")
    Settings = _fresh_settings()
    s = Settings()
    assert s.custom_base_url == "https://litellm.acme.corp/v1"
    assert s.custom_api_key == "sk-test"


def test_settings_default_custom_fields_are_none(monkeypatch):
    monkeypatch.setenv("KLIO_DATABASE_URL", "postgresql+asyncpg://x")
    monkeypatch.delenv("KLIO_CUSTOM_BASE_URL", raising=False)
    monkeypatch.delenv("KLIO_CUSTOM_API_KEY", raising=False)
    Settings = _fresh_settings()
    s = Settings()
    assert s.custom_base_url is None
    assert s.custom_api_key is None
```

**Step 2:** `cd engine && .venv/bin/pytest tests/test_config.py -v` → expect AttributeError on the new fields.

**Step 3: Implement** in `engine/src/klio_engine/config.py`, inside `Settings`:

```python
    # Optional. When set, the engine routes embedding/extraction calls
    # whose model name starts with `custom/` to <custom_base_url>/embeddings
    # (or /chat/completions). Used by the npm onboarding's "Custom"
    # provider option for self-hosted LiteLLM proxies, Azure, vLLM, etc.
    custom_base_url: str | None = None
    custom_api_key: str | None = None
```

**Step 4:** Re-run pytest → both new tests pass.

**Step 5: Commit**

```bash
git add engine/src/klio_engine/config.py engine/tests/test_config.py
git commit -m "feat(engine): add KLIO_CUSTOM_BASE_URL + KLIO_CUSTOM_API_KEY config"
```

---

### Task A2: Replace `_litellm_embed` with `_openrouter_embed` + `_custom_embed`

**Files:**
- Modify: `engine/src/klio_engine/services/embeddings.py` (lines 75-121)
- Test: `engine/tests/test_embeddings_routing.py` (create)

**Step 1: Write the failing test (new file)**

```python
"""Routing dispatch tests for the embedding service.

After dropping LiteLLM (0.3.0), the embedding service routes by
model-name prefix. These tests mock httpx so we don't hit the
network — the assertions are about which URL gets POSTed to.
"""
from __future__ import annotations

import os
from unittest.mock import AsyncMock, patch

import pytest

from klio_engine.services.embeddings import EmbeddingService


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("KLIO_DATABASE_URL", "postgresql+asyncpg://x")
    monkeypatch.setenv("KLIO_OPENROUTER_API_KEY", "sk-or-test")
    monkeypatch.setenv("KLIO_CUSTOM_BASE_URL", "https://proxy.test/v1")
    monkeypatch.setenv("KLIO_CUSTOM_API_KEY", "sk-custom-test")
    return monkeypatch


@pytest.mark.asyncio
async def test_openrouter_prefix_routes_to_openrouter_with_attribution(env):
    svc = EmbeddingService()
    captured = {}

    async def fake_post(self, url, json, headers):
        captured["url"] = url
        captured["json"] = json
        captured["headers"] = headers

        class R:
            def raise_for_status(self): pass
            def json(self): return {"data": [{"embedding": [0.0] * 1536}]}
        return R()

    with patch("httpx.AsyncClient.post", new=fake_post):
        vec, spec = await svc.embed(
            "hello", model="openrouter/openai/text-embedding-3-small"
        )

    assert captured["url"] == "https://openrouter.ai/api/v1/embeddings"
    assert captured["json"]["model"] == "openai/text-embedding-3-small"
    assert captured["headers"]["Authorization"] == "Bearer sk-or-test"
    assert captured["headers"]["X-Title"] == "Klio"
    assert captured["headers"]["HTTP-Referer"] == "https://klio.tech"
    assert len(vec) == 1536


@pytest.mark.asyncio
async def test_custom_prefix_routes_to_user_base_url(env):
    svc = EmbeddingService()
    captured = {}

    async def fake_post(self, url, json, headers):
        captured["url"] = url
        captured["json"] = json
        captured["headers"] = headers

        class R:
            def raise_for_status(self): pass
            def json(self): return {"data": [{"embedding": [0.0] * 1536}]}
        return R()

    with patch("httpx.AsyncClient.post", new=fake_post):
        await svc.embed("hello", model="custom/text-embedding-3-small")

    assert captured["url"] == "https://proxy.test/v1/embeddings"
    assert captured["json"]["model"] == "text-embedding-3-small"
    assert captured["headers"]["Authorization"] == "Bearer sk-custom-test"


@pytest.mark.asyncio
async def test_custom_prefix_omits_auth_when_key_unset(monkeypatch):
    monkeypatch.setenv("KLIO_DATABASE_URL", "postgresql+asyncpg://x")
    monkeypatch.setenv("KLIO_CUSTOM_BASE_URL", "http://localhost:4000/v1")
    monkeypatch.delenv("KLIO_CUSTOM_API_KEY", raising=False)

    svc = EmbeddingService()
    captured = {}

    async def fake_post(self, url, json, headers):
        captured["headers"] = headers
        class R:
            def raise_for_status(self): pass
            def json(self): return {"data": [{"embedding": [0.0] * 1536}]}
        return R()

    with patch("httpx.AsyncClient.post", new=fake_post):
        await svc.embed("hi", model="custom/local-embed")

    assert "Authorization" not in captured["headers"]


@pytest.mark.asyncio
async def test_unknown_prefix_raises_value_error(env):
    svc = EmbeddingService()
    with pytest.raises(ValueError, match="unsupported"):
        await svc.embed("hello", model="anthropic/claude-3-5-haiku")
```

**Step 2:** `cd engine && .venv/bin/pytest tests/test_embeddings_routing.py -v` → all four FAIL.

**Step 3: Implement** in `engine/src/klio_engine/services/embeddings.py`, replacing the existing `_litellm_embed` static method and updating `embed()`:

Replace the dispatch in `embed()` (~line 80-85):

```python
        if spec.name == "stub":
            vector = self._stub_embed(text)
        elif spec.name.startswith("ollama/"):
            vector = await self._ollama_embed(text, spec.name)
        elif spec.name.startswith("openrouter/"):
            vector = await self._openrouter_embed(text, spec.name)
        elif spec.name.startswith("custom/"):
            vector = await self._custom_embed(text, spec.name)
        else:
            raise ValueError(
                f"unsupported model {spec.name!r}: name must start with "
                "ollama/, openrouter/, custom/, or be 'stub'"
            )
```

Replace `_litellm_embed` with two new methods:

```python
    @staticmethod
    async def _openrouter_embed(text: str, name: str) -> list[float]:
        """Direct call to OpenRouter's /embeddings. Strips the
        `openrouter/` prefix the engine uses for routing — the API
        itself expects `<vendor>/<model>` (e.g.
        `openai/text-embedding-3-small`). Sends Klio attribution
        headers so OpenRouter logs requests under the right app."""
        import httpx

        s = Settings()
        if not s.openrouter_api_key:
            raise ValueError(
                "KLIO_OPENROUTER_API_KEY not set but model is "
                f"{name!r}. Re-run `klio init` and pick OpenRouter."
            )
        bare_model = name.removeprefix("openrouter/")
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(
                "https://openrouter.ai/api/v1/embeddings",
                json={"model": bare_model, "input": text},
                headers={
                    "Authorization": f"Bearer {s.openrouter_api_key}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://klio.tech",
                    "X-Title": "Klio",
                },
            )
            r.raise_for_status()
            return r.json()["data"][0]["embedding"]

    @staticmethod
    async def _custom_embed(text: str, name: str) -> list[float]:
        """Direct call to a user-supplied OpenAI-compatible endpoint.
        Same wire shape as OpenRouter; base URL + key come from
        KLIO_CUSTOM_BASE_URL + KLIO_CUSTOM_API_KEY. Auth header
        omitted entirely when no key set (some local proxies reject
        empty Bearer tokens)."""
        import httpx

        s = Settings()
        if not s.custom_base_url:
            raise ValueError(
                "KLIO_CUSTOM_BASE_URL not set but model is "
                f"{name!r}. Re-run `klio init` and pick Custom."
            )
        bare_model = name.removeprefix("custom/")
        headers = {
            "Content-Type": "application/json",
            "HTTP-Referer": "https://klio.tech",
            "X-Title": "Klio",
        }
        if s.custom_api_key:
            headers["Authorization"] = f"Bearer {s.custom_api_key}"

        base = s.custom_base_url.rstrip("/")
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(
                f"{base}/embeddings",
                json={"model": bare_model, "input": text},
                headers=headers,
            )
            r.raise_for_status()
            return r.json()["data"][0]["embedding"]
```

Add `from klio_engine.config import Settings` import at top if not already present.

**Step 4:** Re-run `pytest tests/test_embeddings_routing.py -v` → all four PASS. Re-run `pytest tests/` → existing tests still pass.

**Step 5: Commit**

```bash
git add engine/src/klio_engine/services/embeddings.py engine/tests/test_embeddings_routing.py
git commit -m "feat(engine): direct httpx for OpenRouter + Custom embeddings (drop LiteLLM)"
```

---

### Task A3: Replace LiteLLM in `extractor.py` with direct httpx

**Files:**
- Modify: `engine/src/klio_engine/services/extractor.py:170-200`
- Test: `engine/tests/test_extractor_routing.py` (create)

**Step 1:** Mirror Task A2's test shape — three tests for openrouter/, custom/, and unknown prefix. Assert URL, model name (prefix-stripped), and attribution headers.

**Step 2-4:** Same TDD cycle. The extractor's LiteLLM call site:

```python
async def _llm_chat(messages, model):
    from litellm import acompletion
    response = await acompletion(model=model, messages=messages, ...)
    return response.choices[0].message.content
```

becomes a prefix-routing dispatcher with `_openrouter_chat` and `_custom_chat` helpers. Same shape as `_openrouter_embed` but POSTs to `/chat/completions` with `messages` instead of `input`.

**Step 5: Commit**

```bash
git add engine/src/klio_engine/services/extractor.py engine/tests/test_extractor_routing.py
git commit -m "feat(engine): direct httpx for OpenRouter + Custom chat (drop LiteLLM)"
```

---

### Task A4: Clean up `EMBEDDING_MODELS` registry

**Files:**
- Modify: `engine/src/klio_engine/services/embedding_models.py`
- Test: `engine/tests/test_embedding_models.py`

**Step 1: Write failing tests**

```python
def test_bare_openai_models_removed():
    """0.3.0 drops LiteLLM-routed bare OpenAI rows. Anyone with
    KLIO_EMBEDDING_MODEL=text-embedding-3-small must migrate to
    openrouter/openai/text-embedding-3-small."""
    from klio_engine.services.embedding_models import EMBEDDING_MODELS
    names = {m.name for m in EMBEDDING_MODELS}
    assert "text-embedding-3-small" not in names
    assert "text-embedding-ada-002" not in names


def test_voyage_and_cohere_added():
    from klio_engine.services.embedding_models import EMBEDDING_MODELS
    names = {m.name for m in EMBEDDING_MODELS}
    assert "openrouter/voyage/voyage-3" in names
    assert "openrouter/cohere/embed-multilingual-v3.0" in names


def test_resolve_bare_openai_now_raises():
    from klio_engine.services.embedding_models import resolve
    with pytest.raises(ValueError, match="Unknown embedding model"):
        resolve("text-embedding-3-small")
```

**Step 2:** Run → first one fails (rows still present), others fail.

**Step 3: Implement** — update `EMBEDDING_MODELS` in `embedding_models.py` to the 0.3.0 set per the design doc.

**Step 4:** All pass. Run full engine test suite to confirm nothing else broke.

**Step 5: Commit**

```bash
git add engine/src/klio_engine/services/embedding_models.py engine/tests/test_embedding_models.py
git commit -m "feat(engine): registry cleanup — drop bare-OpenAI rows, add Voyage + Cohere"
```

---

### Task A5: Drop `litellm` from `engine/pyproject.toml`

**Files:**
- Modify: `engine/pyproject.toml`
- Verify: image build still succeeds

**Step 1:** Read `pyproject.toml`. Remove the `litellm` line from `[project.dependencies]`.

**Step 2:** `cd engine && .venv/bin/pip uninstall litellm -y` (verify the engine still imports cleanly without it).

**Step 3:** `cd engine && .venv/bin/pytest tests/ -v` → all pass (no module imports litellm anymore after Tasks A2 + A3).

**Step 4:** Rebuild engine image: `cd /Users/thakurg/Me/klio && docker build -t klio-engine:test ./engine` → confirm clean build, smaller layer.

**Step 5: Commit**

```bash
git add engine/pyproject.toml
git commit -m "chore(engine): drop litellm dependency"
```

---

## Section B — NPM utility: narration + quiet flag

### Task B1: Add `narrate`, `setQuiet`, `phaseHeader`, `phaseRecap` to `ui.ts`

**Files:**
- Modify: `npm/src/ui.ts`
- Test: `npm/tests/ui.test.ts` (create or extend)

**Step 1: Failing tests**

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Writable } from "node:stream";
import { setQuiet, narrate, phaseHeader, phaseRecap } from "../src/ui.js";

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: any) => {
    chunks.push(c.toString());
    return true;
  }) as any;
  try { fn(); } finally { process.stdout.write = orig; }
  return chunks.join("");
}

test("narrate writes indented context line by default", () => {
  setQuiet(false);
  const out = captureStdout(() => narrate("hello"));
  assert.match(out, /\s{8}hello\n/);
});

test("narrate is a no-op when quiet=true", () => {
  setQuiet(true);
  const out = captureStdout(() => narrate("hidden"));
  assert.equal(out, "");
  setQuiet(false);  // reset
});

test("phaseHeader writes a Phase N / 5 banner", () => {
  setQuiet(false);
  const out = captureStdout(() => phaseHeader(3, 5, "Bring up your stack"));
  assert.match(out, /Phase 3 \/ 5/);
  assert.match(out, /Bring up your stack/);
});

test("phaseHeader still prints when quiet=true", () => {
  setQuiet(true);
  const out = captureStdout(() => phaseHeader(2, 5, "x"));
  assert.match(out, /Phase 2 \/ 5/);
  setQuiet(false);
});

test("phaseRecap suppressed when quiet=true", () => {
  setQuiet(true);
  const out = captureStdout(() => phaseRecap("Phase 3 done — engine running."));
  assert.equal(out, "");
  setQuiet(false);
});
```

**Step 2:** `cd npm && npm test` → 5 new tests fail.

**Step 3: Implement** in `npm/src/ui.ts` (append):

```typescript
let _quiet = false;

export function setQuiet(q: boolean): void {
  _quiet = q;
}

/**
 * Indented per-step context line. Suppressed when --quiet is set,
 * so re-runs by experienced users skip the explanatory text.
 */
export function narrate(line: string): void {
  if (_quiet) return;
  process.stdout.write(`        ${line}\n`);
}

/**
 * Section header between phases. Always rendered (even with --quiet)
 * because it's the structural marker that orients the user.
 */
export function phaseHeader(n: number, total: number, title: string): void {
  process.stdout.write(
    `\n───────────────────────────────────────────────────────\n` +
      `Phase ${n} / ${total}  ·  ${title}\n\n`
  );
}

/**
 * Phase-boundary recap — one dim line summarising what was just
 * accomplished. Suppressed when --quiet.
 */
export function phaseRecap(line: string): void {
  if (_quiet) return;
  process.stdout.write(`\n  ${line}\n`);
}
```

**Step 4:** `npm test` → all pass. `npm run build` → clean.

**Step 5: Commit**

```bash
git add npm/src/ui.ts npm/tests/ui.test.ts
git commit -m "feat(npm): narrate/phaseHeader/phaseRecap helpers + setQuiet"
```

---

### Task B2: Add `--quiet` flag to `cli.ts` + thread into `init.ts`

**Files:**
- Modify: `npm/src/cli.ts:67-90`
- Modify: `npm/src/commands/init.ts:53-65`

**Step 1: Failing test (extend cli.test.ts or init.test.ts)**

```typescript
test("init parses --quiet flag", () => {
  // Argv parser sets opts.quiet = true when --quiet present
  // (this is a unit-test of parseInitArgs in cli.ts;
  // export it for testability if not already exported)
});
```

**Step 2-4:** Add `quiet?: boolean` to `InitOptions`. Add `--quiet` to the argv parser. In `init()`, call `setQuiet(opts.quiet ?? false)` once near the top.

**Step 5: Commit**

```bash
git add npm/src/cli.ts npm/src/commands/init.ts npm/tests/init.test.ts
git commit -m "feat(npm): --quiet flag wired into init"
```

---

## Section C — NPM: provider menu

### Task C1: `providerMenu.ts` module

**Files:**
- Create: `npm/src/providerMenu.ts`
- Create: `npm/tests/providerMenu.test.ts`

**Step 1: Failing tests**

```typescript
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { selectProvider, type ProviderKind } from "../src/providerMenu.js";

test("default picks OpenRouter", async () => {
  const result = await selectProvider({
    promptFn: async () => "",  // empty → default
    log: () => {},
  });
  assert.equal(result, "openrouter" satisfies ProviderKind);
});

test("user picks Ollama with 2", async () => {
  const result = await selectProvider({
    promptFn: async () => "2",
    log: () => {},
  });
  assert.equal(result, "ollama");
});

test("user picks Custom with 3", async () => {
  const result = await selectProvider({
    promptFn: async () => "3",
    log: () => {},
  });
  assert.equal(result, "custom");
});

test("invalid input re-prompts", async () => {
  const inputs = ["banana", "999", "1"];
  let i = 0;
  const result = await selectProvider({
    promptFn: async () => inputs[i++],
    log: () => {},
  });
  assert.equal(result, "openrouter");
  assert.equal(i, 3);  // it iterated until valid
});
```

**Step 2-4:** Implement `selectProvider({promptFn, log}) => Promise<ProviderKind>`. Accept `1`/`2`/`3` (default `1` on empty), reject anything else with a re-prompt. Log the menu rendering before each prompt.

```typescript
export type ProviderKind = "openrouter" | "ollama" | "custom";

export type MenuDeps = {
  promptFn: (opts: { message: string; default?: string }) => Promise<string>;
  log: (line: string) => void;
};

export async function selectProvider(deps: MenuDeps): Promise<ProviderKind> {
  deps.log("");
  deps.log("  Pick your model provider:");
  deps.log("    1) OpenRouter   one API key, hundreds of models — recommended");
  deps.log("    2) Ollama       fully local, your text never leaves the machine");
  deps.log("    3) Custom       bring your own OpenAI-compatible endpoint");
  deps.log("                    (LiteLLM proxy, Azure, vLLM, etc.)");
  deps.log("");

  while (true) {
    const choice = await deps.promptFn({ message: "Choice", default: "1" });
    const trimmed = choice.trim();
    if (trimmed === "" || trimmed === "1") return "openrouter";
    if (trimmed === "2") return "ollama";
    if (trimmed === "3") return "custom";
    deps.log(`      ✗ pick 1, 2, or 3 (got ${JSON.stringify(trimmed)})`);
  }
}
```

**Step 5: Commit**

```bash
git add npm/src/providerMenu.ts npm/tests/providerMenu.test.ts
git commit -m "feat(npm): provider menu (OpenRouter / Ollama / Custom)"
```

---

## Section D — NPM: OpenRouter live model catalog

### Task D1: Add `fetchModelCatalog` + curation helpers to `openrouter.ts`

**Files:**
- Modify: `npm/src/openrouter.ts` (append)
- Modify: `npm/tests/openrouter.test.ts` (extend)

**Step 1: Failing tests**

```typescript
test("fetchModelCatalog returns the data array", async () => {
  installFetch(async () => ok({
    data: [
      { id: "openai/text-embedding-3-small", architecture: { modality: "text->embedding" }, pricing: { prompt: "0.00000002" } },
      { id: "anthropic/claude-3-5-haiku", architecture: { modality: "text->text" }, supported_parameters: ["tools"], pricing: { prompt: "0.0000008", completion: "0.000004" } },
    ],
  }));
  const cat = await fetchModelCatalog("sk-or-test");
  assert.equal(cat.length, 2);
});

test("curateEmbeddingModels filters to supported dims, takes top 3 by price", () => {
  const catalog = [
    { id: "x/big", architecture: { modality: "text->embedding" }, pricing: { prompt: "0.00000013" }, context_length: 8192 },
    { id: "x/small", architecture: { modality: "text->embedding" }, pricing: { prompt: "0.00000002" }, context_length: 8192 },
    { id: "x/chat", architecture: { modality: "text->text" }, pricing: { prompt: "0.000001" } },
    { id: "x/medium", architecture: { modality: "text->embedding" }, pricing: { prompt: "0.00000006" } },
    { id: "x/3072dim", architecture: { modality: "text->embedding" }, pricing: { prompt: "0.00000013" } },
  ];
  // Knowledge of dim per model is encoded in our supported-dim map;
  // anything not in the map is dropped.
  const out = curateEmbeddingModels(catalog as any);
  // Returns at most 3, sorted by price ascending
  assert(out.length <= 3);
  // x/chat dropped (wrong modality), x/3072dim dropped (unknown dim)
  assert(out.every(m => m.id !== "x/chat" && m.id !== "x/3072dim"));
});

test("curateChatModels keeps known-curated names that exist in catalog", () => {
  const catalog = [
    { id: "anthropic/claude-3-5-haiku", architecture: { modality: "text->text" }, supported_parameters: ["tools"], pricing: { prompt: "0.0000008", completion: "0.000004" } },
    { id: "openai/gpt-4o-mini", architecture: { modality: "text->text" }, supported_parameters: ["tools"], pricing: { prompt: "0.00000015", completion: "0.0000006" } },
    { id: "openai/text-embedding-3-small", architecture: { modality: "text->embedding" } },  // wrong modality
  ];
  const out = curateChatModels(catalog as any);
  const ids = out.map(m => m.id);
  assert(ids.includes("anthropic/claude-3-5-haiku"));
  assert(ids.includes("openai/gpt-4o-mini"));
  assert(!ids.includes("openai/text-embedding-3-small"));
});
```

**Step 2-4:** Implement:

```typescript
export type CatalogEntry = {
  id: string;
  architecture?: { modality?: string };
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  context_length?: number;
};

const SUPPORTED_EMBED_DIMS_BY_MODEL: Record<string, number> = {
  "openai/text-embedding-3-small": 1536,
  "openai/text-embedding-ada-002": 1536,
  "voyage/voyage-3": 1024,
  "voyage/voyage-3-lite": 512,  // unsupported, will be dropped
  "cohere/embed-multilingual-v3.0": 1024,
  "cohere/embed-english-v3.0": 1024,
};

const SUPPORTED_DIMS = new Set([768, 1024, 1536]);

const CURATED_CHAT_MODELS = [
  "anthropic/claude-3-5-haiku",
  "anthropic/claude-3-5-sonnet",
  "openai/gpt-4o-mini",
  "openai/gpt-4o",
  "google/gemini-flash-1.5",
  "meta-llama/llama-3.1-70b-instruct",
];

export async function fetchModelCatalog(key: string): Promise<CatalogEntry[]> {
  const res = await fetch(`${BASE}/models`, {
    headers: orHeaders(key),
  });
  if (!res.ok) throw new Error(`OpenRouter /models failed (HTTP ${res.status})`);
  const body = await res.json() as { data?: CatalogEntry[] };
  return body.data ?? [];
}

export function curateEmbeddingModels(catalog: CatalogEntry[]): CatalogEntry[] {
  return catalog
    .filter(m => m.architecture?.modality === "text->embedding")
    .filter(m => {
      const dim = SUPPORTED_EMBED_DIMS_BY_MODEL[m.id];
      return dim !== undefined && SUPPORTED_DIMS.has(dim);
    })
    .sort((a, b) =>
      Number(a.pricing?.prompt ?? "0") - Number(b.pricing?.prompt ?? "0")
    )
    .slice(0, 3);
}

export function curateChatModels(catalog: CatalogEntry[]): CatalogEntry[] {
  const byId = new Map(catalog.map(m => [m.id, m]));
  return CURATED_CHAT_MODELS
    .map(id => byId.get(id))
    .filter((m): m is CatalogEntry =>
      m !== undefined &&
      m.architecture?.modality === "text->text" &&
      (m.supported_parameters?.includes("tools") ?? false)
    );
}
```

Add the `orHeaders` helper here so all OpenRouter calls share it (X-Title + HTTP-Referer + Auth).

**Step 5: Commit**

```bash
git add npm/src/openrouter.ts npm/tests/openrouter.test.ts
git commit -m "feat(npm): live OpenRouter catalog fetch + curation + attribution headers"
```

---

### Task D2: Numbered picker UX in `providerSetup.ts`

Refactor `providerSetup.ts` so the embedding + chat collection use a numbered list when a curated subset is available, falling back to free-form text. Custom typing always allowed.

**Files:**
- Modify: `npm/src/providerSetup.ts`
- Modify: `npm/tests/providerSetup.test.ts`

**Step 1-4:** Standard TDD. Add a `pickFromMenu(deps, options, defaultIdx)` helper in providerSetup that:
- Accepts a numbered list of `{id, label, description?}`
- Returns the picked id when input is a valid number
- Returns the typed string when input is anything else
- Uses the default when input is empty

Example UI:

```
   1) openai/text-embedding-3-small   $0.02/1M  · 1536 dim · ★ default
   2) voyage/voyage-3                 $0.06/1M  · 1024 dim
   3) cohere/embed-multilingual-v3.0  $0.11/1M  · 1024 dim · multilingual
   (or type any model name)
   Choice [1] › 
```

**Step 5: Commit**

```bash
git add npm/src/providerSetup.ts npm/tests/providerSetup.test.ts
git commit -m "feat(npm): numbered picker for OpenRouter model selection"
```

---

## Section E — NPM: Ollama sub-flow

### Task E1: Detect Ollama daemon + list models

**Files:**
- Create: `npm/src/ollama.ts`
- Create: `npm/tests/ollama.test.ts`

**Step 1: Failing tests** — mock fetch (since detection uses `GET http://127.0.0.1:11434/api/tags`).

```typescript
test("isOllamaRunning returns true when /api/tags responds 200", async () => {
  installFetch(async () => ok({ models: [] }));
  assert.equal(await isOllamaRunning(), true);
});

test("isOllamaRunning returns false on connection refused", async () => {
  installFetch(async () => { throw new Error("ECONNREFUSED"); });
  assert.equal(await isOllamaRunning(), false);
});

test("listInstalledModels returns name array", async () => {
  installFetch(async () => ok({
    models: [
      { name: "nomic-embed-text:latest", size: 274_000_000 },
      { name: "llama3.1:8b", size: 4_700_000_000 },
    ],
  }));
  const out = await listInstalledModels();
  assert.deepEqual(out.map(m => m.name), [
    "nomic-embed-text:latest",
    "llama3.1:8b",
  ]);
});

test("filterToSupportedEmbed keeps only known-dim models", () => {
  const all = [
    { name: "nomic-embed-text:latest", size: 1 },
    { name: "llama3.1:8b", size: 1 },
    { name: "snowflake-arctic-embed2:l", size: 1 },
  ];
  const out = filterToSupportedEmbed(all);
  assert(out.some(m => m.name.startsWith("nomic-embed-text")));
  assert(out.some(m => m.name.startsWith("snowflake-arctic-embed2")));
  assert(!out.some(m => m.name.startsWith("llama3.1")));
});
```

**Step 2-4:** Implement detection + listing + the `OLLAMA_EMBED_DIMS` map per the design.

**Step 5: Commit**

```bash
git add npm/src/ollama.ts npm/tests/ollama.test.ts
git commit -m "feat(npm): Ollama detection + model listing"
```

---

### Task E2: `pullOllamaModel` with streaming progress + consent

**Files:**
- Modify: `npm/src/ollama.ts`
- Modify: `npm/tests/ollama.test.ts`

**Step 1-4:** Wrap `ollama pull <name>` via `child_process.spawn`, stream stderr to a callback. Test by injecting a fake spawner.

**Step 5: Commit**

```bash
git add npm/src/ollama.ts npm/tests/ollama.test.ts
git commit -m "feat(npm): pull Ollama models with streaming progress"
```

---

### Task E3: `setupOllama` orchestrator with fallback

**Files:**
- Modify: `npm/src/providerSetup.ts`

**Step 1-4:** Mirror `setupProvider` shape but for Ollama. On detection failure, return a sentinel that signals the init flow to switch to OpenRouter (or abort). Tests cover all three branches: installed+running, installed+down, not-installed.

**Step 5: Commit**

```bash
git add npm/src/providerSetup.ts npm/tests/providerSetup.test.ts
git commit -m "feat(npm): Ollama provider setup with friendly OpenRouter fallback"
```

---

## Section F — NPM: Custom endpoint

### Task F1: `customEndpoint.ts` with probe + model-list fallback

**Files:**
- Create: `npm/src/customEndpoint.ts`
- Create: `npm/tests/customEndpoint.test.ts`

**Step 1-4:** TDD. Functions:

- `probeCustomEndpoint(baseUrl, apiKey | undefined): Promise<{models: string[] | null}>` — hits `<baseUrl>/models`. Returns model list on success, `null` on 404 (proxy disabled it). Throws on auth failure (4xx other than 404).
- `probeCustomEmbedding(baseUrl, apiKey, model)` and `probeCustomChat` — same shape as the OpenRouter probes but parameterised on baseUrl.

All HTTP calls send the X-Title + HTTP-Referer attribution headers.

**Step 5: Commit**

```bash
git add npm/src/customEndpoint.ts npm/tests/customEndpoint.test.ts
git commit -m "feat(npm): custom OpenAI-compatible endpoint probes"
```

---

### Task F2: `setupCustom` orchestrator

**Files:**
- Modify: `npm/src/providerSetup.ts`

**Step 1-4:** Same shape as `setupProvider` (now `setupOpenRouter`) but for custom. Three sequential prompts (base URL, API key, then per-model picks). Models picker uses the response of `/models` if available; falls back to free-form text.

**Step 5: Commit**

```bash
git add npm/src/providerSetup.ts npm/tests/providerSetup.test.ts
git commit -m "feat(npm): custom endpoint provider setup"
```

---

## Section G — NPM: init refactor + compose updates

### Task G1: Compose template — add `KLIO_CUSTOM_BASE_URL` + `KLIO_CUSTOM_API_KEY`

**Files:**
- Modify: `npm/src/compose.ts:200-210`
- Modify: `npm/tests/compose.test.ts`

**Step 1: Failing test** — assert the rendered body contains both new env vars in the engine block.

**Step 2-4:** Add to `renderComposeBody`:

```yaml
      KLIO_CUSTOM_BASE_URL: ${KLIO_CUSTOM_BASE_URL}
      KLIO_CUSTOM_API_KEY: ${KLIO_CUSTOM_API_KEY}
```

**Step 5: Commit**

```bash
git add npm/src/compose.ts npm/tests/compose.test.ts
git commit -m "feat(npm): compose template plumbs Custom endpoint envs"
```

---

### Task G2: Restructure `init.ts` into 5 phases with provider-menu dispatch

**Files:**
- Modify: `npm/src/commands/init.ts` (substantial rewrite)

**Step 1-4:** Wrap each existing step block in `phaseHeader()` + `phaseRecap()`. Insert provider menu (Section C) in Phase 2 before the existing provider setup. Branch on `selectProvider()` result:

```typescript
const provider = await selectProvider(...);
let providerCfg;
switch (provider) {
  case "openrouter": providerCfg = await setupOpenRouter(...); break;
  case "ollama":     providerCfg = await setupOllama(...); break;  // may return "fallback to openrouter"
  case "custom":     providerCfg = await setupCustom(...); break;
}
```

`providerCfg` is a tagged union: `{kind: "openrouter", openrouterKey, embeddingModel, extractionModel, embeddingDim, totalTestTokens}` | `{kind: "ollama", embeddingModel, extractionModel, embeddingDim}` | `{kind: "custom", baseUrl, apiKey, embeddingModel, extractionModel, embeddingDim}`.

The compose-write step branches on `providerCfg.kind` to write the right env vars + apply the right model-name prefix (`openrouter/`, `ollama/`, `custom/`).

Each `▸ step…` gets a `narrate(...)` call with one-line context per the design's Section 5.

Add an init smoke test that verifies the new `InitOptions` shape compiles and `init` is exported.

**Step 5: Commit**

```bash
git add npm/src/commands/init.ts npm/tests/init.test.ts
git commit -m "feat(npm): 5-phase init flow with provider menu + narration"
```

---

## Section H — Engine compose update

The engine container needs to read `KLIO_CUSTOM_BASE_URL` + `KLIO_CUSTOM_API_KEY` from compose. The compose template task (G1) already plumbs them; this task just verifies the engine picks them up at runtime via the existing `Settings` field added in Task A1.

**Step:** Manual verification — bring up a fresh stack with `KLIO_CUSTOM_BASE_URL=...` set, hit `/v1/users/provision`, confirm a write+recall round-trip works. No commit needed if everything passes.

---

## Section I — Ship 0.3.0

### Task I1: Bump npm/package.json to 0.3.0

```bash
cd /Users/thakurg/Me/klio/npm
node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json','utf8')); p.version='0.3.0'; fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n')"
npm install --package-lock-only --no-audit --no-fund
cd ..
git add npm/package.json npm/package-lock.json
git commit -m "chore(npm): release 0.3.0 — immersive onboarding + drop LiteLLM"
```

**DO NOT push.** Per user instruction, hold the branch locally until manual review.

### Task I2: Local end-to-end smoke

Build engine + bridge + trust-app images locally, tag as `ghcr.io/klio-tech/klio-{engine,bridge,trust-app}:0.3.0`. Run `npm pack` then `npx ./klio-tech-klio-0.3.0.tgz init` from a fresh directory.

Verify:
- 5-phase headers visible
- Per-step narration appears (no `--quiet`)
- Provider menu shows three options
- OpenRouter sub-flow: validates key, fetches catalog, shows numbered embedding picker (3 entries), shows numbered chat picker (6 entries), validates pick
- Compose comes up
- Account provisions (no "Unknown embedding model" — registry has the new entries)
- Adapter detection wires Claude Code + Cursor + Codex
- Wow moment runs end-to-end
- Community asks fire

If anything's off, fix in a follow-up commit on the same branch.

### Task I3: Push (only after user approval)

When user explicitly approves:

```bash
git push origin feat/immersive-onboarding
# then merge to main:
git checkout main && git merge --ff-only feat/immersive-onboarding && git push
```

CI publishes 0.3.0 npm + retags GHCR images.

### Task I4: Final cross-branch code review

Dispatch a final code reviewer subagent against the whole branch
(`fda0220..head`). Address Critical/Important issues before merge.

---

## Closing notes

- **Tests:** every TS module has a sibling `*.test.ts`. `cd npm && npm test` should pass after every task. Engine: `cd engine && .venv/bin/pytest tests/` after each engine task.
- **Coverage target:** 80% line coverage on new modules.
- **Rollback path:** if 0.3.0 breaks, `npm publish --tag v0.2.x` keeps old users on a known-good. Don't unpublish 0.2.x.
- **Skill follow-up:** for execution, use `superpowers:subagent-driven-development` (same-session, fresh subagent per task with two-stage review) or `superpowers:executing-plans` (separate session, batched).
