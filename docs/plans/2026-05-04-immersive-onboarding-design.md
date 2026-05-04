# Immersive onboarding + drop LiteLLM — design

**Date:** 2026-05-04
**Status:** Approved, ready for implementation plan
**Predecessors:** 2026-05-04 OpenRouter onboarding (shipped as 0.2.x)
**Target release:** `@klio-tech/klio@0.3.0`

## Why this exists

`0.2.x` shipped a working OpenRouter-default onboarding flow but the user
experience felt rushed and under-guided. Concretely:

- The provider was a silent default — users couldn't see they had a
  choice, and Ollama (the privacy-purist path) was effectively hidden.
- Model selection was free-form typing with one default suggestion. New
  users don't know good model names from bad ones.
- The engine still routed via LiteLLM even though OpenRouter is itself a
  multi-provider gateway — two abstractions stacked, opaque errors,
  ~30 transitive deps we don't need.
- No section structure: 11 successive `▸ step…` lines blur into one
  another. Users couldn't tell which phase they were in or what was
  happening behind the scenes.

`0.3.0` fixes all of that without changing the architecture.

## Goals

1. **Provider menu** with three real options: OpenRouter, Ollama, Custom.
2. **Live model catalog** for OpenRouter — fetch `/models`, show a
   curated subset by role (embedding vs chat) with prices, let user pick
   by number or type a custom name.
3. **Friendly Ollama path** — detect daemon, pull missing models with
   consent, fall back to OpenRouter if absent.
4. **Custom endpoint** — base URL + API key, OpenAI-compatible, covers
   self-hosted LiteLLM proxies, Azure OpenAI, vLLM, Together, Groq.
5. **Drop LiteLLM from the engine** — direct httpx calls to OpenRouter
   and to custom endpoints. Keep direct httpx for Ollama (already in
   place).
6. **OpenRouter attribution headers** on every call: `HTTP-Referer:
   https://klio.tech`, `X-Title: Klio`.
7. **Five-phase narration** with section headers, per-step context
   one-liners, phase-boundary recaps. `--quiet` flag for re-runs.

## Non-goals

- Auto-installing Ollama. Telling users to `brew install` themselves.
- Persisting `--quiet` preference across runs (defer to 0.4).
- Backfill of old 0.2.x users — they re-init, npm package's idempotency
  reuses their install_id and gets the same user_id back.
- Replacing the full multi-provider matrix LiteLLM gave us. We keep
  three known paths (Ollama, OpenRouter, Custom). Anyone needing a
  different provider runs Custom against a LiteLLM proxy.

## The five phases

Visible to the user as section dividers:

```
Phase 1 / 5  ·  Preflight                 (Docker check)
Phase 2 / 5  ·  Connect a model           (provider menu + sub-flow)
Phase 3 / 5  ·  Bring up your stack       (compose write/pull/up + engine wait + provision)
Phase 4 / 5  ·  Wire your AI agents       (Claude Code, Cursor, Codex)
Phase 5 / 5  ·  Prove it works            (forced wow moment)
```

End-of-init: community asks (star + Discord) + final reference block
(dashboard URL, status command, stop command).

## Provider menu

```
▸ Pick your model provider:
   1) OpenRouter   one API key, hundreds of models — recommended
   2) Ollama       fully local, your text never leaves the machine
   3) Custom       bring your own OpenAI-compatible endpoint
                   (LiteLLM, Azure, vLLM, Together, etc.)

   Choice [1] › ‹enter›
```

Default is OpenRouter. Each branch leads to its own sub-flow.

## OpenRouter sub-flow

After menu pick:

1. **API key prompt** with masked input. Validate via `GET /auth/key`.
   Surface key label + remaining credit.
2. **Fetch live model catalog** via `GET /models` (one call, cached for
   the session).
3. **Embedding model picker** — filter catalog to:
   - `architecture.modality === "text->embedding"`
   - dim ∈ {768, 1024, 1536} (the engine's supported shadow tables)
   - sort by price ascending
   - take top 3
   - Show numbered list with price/dim, default highlighted.
   - User picks by number, or types a custom model name.
4. **Chat model picker** — curated set of 6 well-known names, all of
   which support function calling (extraction needs that):
   `claude-3-5-haiku`, `claude-3-5-sonnet`, `gpt-4o-mini`, `gpt-4o`,
   `gemini-flash-1.5`, `llama-3.1-70b-instruct`. Any deprecated by the
   live catalog gets dropped silently. User picks by number or custom.
5. **Validate each pick** with one tiny test request. Disclose the
   ≈$0.0002 total upfront, show per-call cost.

Model names sent to the engine via `KLIO_EMBEDDING_MODEL` and
`KLIO_EXTRACTION_MODEL` always carry the `openrouter/` prefix
(prepended by the npm package; LiteLLM-style routing convention the
engine retains for clarity).

## Ollama sub-flow

Three branches:

| Detection result | Behaviour |
|---|---|
| Ollama installed + daemon up | Show installed models filtered by dim ∈ {768, 1024, 1536} for embedding; show all for chat. Numbered picker. Custom typing allowed. If embedding list is empty, offer to `ollama pull nomic-embed-text` (~274 MB) with [Y/n]. Same for chat → offer `llama3.1:8b`. |
| Ollama installed, daemon down | Print start command for the user's OS (`brew services start ollama` / `systemctl --user start ollama`). Offer fallback: "Use OpenRouter for now? [Y/n]". On Y, switch to OpenRouter sub-flow. On n, abort. |
| Ollama not installed | Print install URL for the user's OS. Offer same fallback to OpenRouter. |

We never run `brew install` or `curl | sh`. That's a security boundary
we don't cross silently — but once Ollama IS installed, driving
`ollama pull` is fine because Ollama is the trusted boundary at that
point.

Detection via:
- `which ollama` for installation
- `GET http://127.0.0.1:11434/api/tags` for daemon liveness AND model
  list (saves a separate `ollama list` invocation)

## Custom sub-flow

After menu pick:

1. **Base URL prompt** — examples shown
   (`https://litellm.acme.corp/v1`, `http://127.0.0.1:4000/v1`,
   `https://api.together.xyz/v1`).
2. **API key prompt** — empty allowed for unauthenticated local proxies.
   When empty, we omit the `Authorization` header entirely (rather than
   sending `Authorization: Bearer ` which some proxies reject).
3. **Validate** via `GET <base>/models`. Success = reachable + auth ok.
4. **Embedding + chat model pickers** — if `/models` returned a list,
   show first 5 + "type any" escape; if `/models` 404'd, fall back to
   free-form typing.
5. **Probe each pick** with a real test request. Same as OpenRouter.

Model names get the `custom/` prefix when written to the engine env.
Routing inside the engine: `custom/<name>` → POST
`<KLIO_CUSTOM_BASE_URL>/embeddings` (or `/chat/completions`) with the
bare model name.

Attribution headers (`X-Title: Klio`, `HTTP-Referer: https://klio.tech`)
are sent to Custom endpoints too — harmless to proxies that ignore them,
useful to ones that log them.

## Engine — drop LiteLLM, route by prefix

Replace `_litellm_embed` and the LiteLLM call in `extractor.py` with
two new direct-httpx functions: `_openrouter_embed`,
`_openrouter_chat`, plus a `_custom_*` pair parameterised by base URL
+ key.

Resulting routing dispatch:

```python
if spec.name == "stub":                       _stub
elif spec.name.startswith("ollama/"):         _ollama_embed
elif spec.name.startswith("openrouter/"):     _openrouter_embed
elif spec.name.startswith("custom/"):         _custom_embed
else:                                          ValueError
```

Three known paths, anything else fails loudly with a clear message.

`engine/pyproject.toml` loses `litellm` and (transitively) `tiktoken`,
parts of `tokenizers`, vendored `boto3`, etc. Engine image rebuilds
~50-100 MB lighter (estimate; some are kept by other packages).

### Registry cleanup

`EMBEDDING_MODELS` becomes:

```python
EMBEDDING_MODELS = (
    EmbeddingModelSpec("ollama/nomic-embed-text",            768, "ollama"),
    EmbeddingModelSpec("ollama/mxbai-embed-large",          1024, "ollama"),
    EmbeddingModelSpec("ollama/snowflake-arctic-embed2",    1024, "ollama"),
    EmbeddingModelSpec("ollama/bge-m3",                     1024, "ollama"),
    EmbeddingModelSpec("openrouter/openai/text-embedding-3-small",  1536, "openrouter"),
    EmbeddingModelSpec("openrouter/voyage/voyage-3",                1024, "openrouter"),
    EmbeddingModelSpec("openrouter/cohere/embed-multilingual-v3.0", 1024, "openrouter"),
    EmbeddingModelSpec("stub",                              1536, "internal"),
)
```

Removed: `text-embedding-3-small` and `text-embedding-ada-002` (bare,
non-prefixed). They were direct-OpenAI shortcuts that never worked
without `OPENAI_API_KEY` (which we never set). Anyone hardcoding them
gets a clear error and migrates to the `openrouter/` prefixed form.

For Custom-endpoint models the engine doesn't enumerate every possible
name; the npm package probes the user's pick at onboarding time and
persists the resulting dim into the user's space record. Same pattern
already used to handle per-space dims.

## Narration shape

Per-step context one-liners, indented under the `▸` marker:

```
   ▸ Pulling container images…
        Klio's three images come from GitHub Container Registry
        (klio-engine, klio-bridge, klio-trust-app). Public, signed.
     ✓ images up to date (53.5s)
```

**Rules** (enforced by review, not code):
1. One line max. Two lines only if a URL or example forces a wrap.
2. Specific and useful — never marketing fluff.
3. Explains either *what's happening behind the scenes* or *why this
   step matters*. The `▸` marker already signals "in progress" so we
   don't restate that.

**Phase-boundary recap** — one dim line after each phase:

```
  Phase 3 done — engine, bridge, postgres, redis all running.
```

## `--quiet` flag

`npx @klio-tech/klio init --quiet` strips:
- Welcome preview (the "In about two minutes…" block)
- Per-step narration (the indented context lines)
- Phase-boundary recaps

Keeps:
- Phase headers (still useful for orientation)
- `▸` / `✓` / `✗` / `—` markers
- Interactive prompts (provider menu, model pickers, wow memory,
  community asks)
- Final reference block

Implementation: single `narrate(line)` helper in `npm/src/ui.ts` that's
a no-op when `setQuiet(true)` is called. `init.ts` flips it once based
on the parsed flag.

## File changes (high-level)

**npm package:**
- `src/providerMenu.ts` (NEW) — render the 3-option menu, return user's pick
- `src/openrouter.ts` — add live `/models` fetch + curation helpers, add attribution headers
- `src/ollama.ts` (NEW) — detect, list models, drive `ollama pull` with consent
- `src/customEndpoint.ts` (NEW) — base URL + key probe, model fetch w/ fallback
- `src/providerSetup.ts` — split into per-provider sub-flows; orchestrator dispatches based on menu pick
- `src/ui.ts` — add `narrate()`, `setQuiet()`, `phaseHeader()`, `phaseRecap()`
- `src/commands/init.ts` — restructure into 5 phase blocks
- `src/cli.ts` — add `--quiet` flag

**engine:**
- `src/klio_engine/services/embeddings.py` — replace `_litellm_embed`
  with `_openrouter_embed` + `_custom_embed`; routing dispatch by prefix
- `src/klio_engine/services/extractor.py` — same replacement for chat
- `src/klio_engine/services/embedding_models.py` — drop bare-OpenAI rows
- `src/klio_engine/config.py` — add `custom_base_url`, `custom_api_key`
- `pyproject.toml` — drop `litellm`

**compose template:**
- Add `KLIO_CUSTOM_BASE_URL`, `KLIO_CUSTOM_API_KEY` env vars to engine
  service block.

## Tests

- npm: provider menu, model curation logic (filter + sort + take-N),
  Ollama detection branches, Custom endpoint validation, narrate/quiet
- engine: prefix-routing dispatch, OpenRouter embed via httpx (mock),
  Custom embed via httpx (mock), registry cleanup
- integration: end-to-end smoke against real OpenRouter test key
  (skipif-gated)

## Rollout

`0.3.0` ships as a single npm publish + GHCR retag. The image tag
matches the npm package version (existing CI auto-tags from
`npm/package.json`). Users on 0.2.x re-run `npx @klio-tech/klio init`
to upgrade — npm picks up `latest` automatically.

No data migration needed: existing user/agent/space rows keep working;
embedding-model strings already use the `openrouter/` or `ollama/`
prefix.
