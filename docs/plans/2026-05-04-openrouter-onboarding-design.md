# OpenRouter onboarding + forced wow moment — design

**Date:** 2026-05-04
**Status:** Approved, ready for implementation plan
**Predecessors:** 2026-05-02 architecture; current `npx @klio-tech/klio init` v0.1.1

## Goal

Turn `npx @klio-tech/klio init` from "stack comes up" into "stack comes
up, you write a memory, your AI recalls it, you understand the
product." The whole loop should land in under two minutes on a fresh
machine, with the user never editing a config file by hand.

Two product shifts power this:

1. **OpenRouter replaces Ollama as the default model provider.** The
   privacy story softens slightly (memory text is sent to OpenRouter
   for vectorization + extraction), but onboarding goes from ~6 min to
   ~30 sec. Ollama becomes opt-in via `klio init --local`.
2. **A "forced wow moment" closes the install.** The CLI prompts the
   user for one memory, saves it, and instructs them to verify it in
   Claude Code. The first thing the user does after install is *use
   the product*, not poke at a dashboard.

## Non-goals

- Cross-device sync. Klio Cloud waitlist still applies.
- Replacing the Go-side `klio init` orchestrator. That stays for
  in-repo dev work; the npm path is the user-facing one.
- Auto-installing Ollama. `--local` mode tells the user how to
  install Ollama themselves (we won't run `brew install` for them).
- Auto-detecting which agents the user prefers. We detect what's on
  disk and ask; we don't second-guess.

## Architecture changes

```
                        ┌──────────────────────────────────┐
                        │  npm: @klio-tech/klio (this PR)  │
                        │                                  │
                        │  cli.ts                          │
                        │  ├─ commands/init.ts (rewritten) │
                        │  ├─ banner.ts (new)              │
                        │  ├─ prompt.ts (new)              │
                        │  ├─ openrouter.ts (new)          │
                        │  ├─ wow.ts (new)                 │
                        │  └─ open-url.ts (new)            │
                        │                                  │
                        │  adapters/                       │
                        │  ├─ claudeCode.ts (existing)     │
                        │  ├─ cursor.ts (existing)         │
                        │  └─ codex.ts (NEW — TOML)        │
                        └──────────────────────────────────┘
                                       │
                                       ▼ writes
                        ┌──────────────────────────────────┐
                        │  ~/.klio/runtime/                │
                        │  ├─ docker-compose.yml           │
                        │  ├─ .env (now incl. OR key,      │
                        │  │        embed model,            │
                        │  │        extraction model)       │
                        │  └─ install.json                  │
                        └──────────────────────────────────┘
                                       │
                                       ▼ env vars
                        ┌──────────────────────────────────┐
                        │  klio-engine container           │
                        │  KLIO_EMBEDDING_MODEL=            │
                        │     openrouter/openai/text-       │
                        │     embedding-3-small            │
                        │  KLIO_EXTRACTION_MODEL=           │
                        │     openrouter/anthropic/         │
                        │     claude-3-5-haiku             │
                        │  OPENROUTER_API_KEY=sk-or-…       │
                        │                                  │
                        │  LiteLLM routes both through      │
                        │  OpenRouter via the standard      │
                        │  `openrouter/<vendor>/<model>`    │
                        │  prefix.                          │
                        └──────────────────────────────────┘
```

Bridge code (Go) gets a parallel Codex adapter so `klio init`
(in-repo path) covers the same three tools. No protocol changes.

## End-to-end UX

The full sequence the user sees:

```
$ npx @klio-tech/klio init


   ▔▔▔▔▔
     ▔▔▔     klio
   ▔▔▔▔▔     give every AI agent a memory they share


Setting up Klio
───────────────────────────────────────────────────────

▸ Checking Docker…                     ✓ docker 28.3.2 (140ms)
▸ Pulling images…                      ✓ engine, bridge, trust-app
▸ Starting services…                   ✓ 4 services healthy
▸ Waiting for engine…                  ✓ http://127.0.0.1:8000


▸ Connecting to your model provider…

    Klio uses one model to vectorize memories and one to extract
    them from your sessions. Both run through OpenRouter using
    your key.

    Heads-up: we'll send one tiny test request per model
    (≈$0.0002 total) to confirm they work. If a test fails, we
    tell you and you re-enter — nothing else happens until
    everything checks out.

    OpenRouter API key › sk-or-v1-•••••••••••
      → testing… ✓ Valid · $42.13 credit available

    Embedding model [openai/text-embedding-3-small] › ‹enter›
      → testing… ✓ 1536-dim, charged $0.000001

    Extraction model [anthropic/claude-3-5-haiku] › ‹enter›
      → testing… ✓ responded in 240ms, charged $0.00015

  ✓ provider configured · total test cost $0.000151 (3.2s)


▸ Setting up your account…             ✓ user, agent, default space


▸ Detecting your AI tools…

    Found:    Claude Code, Cursor, Codex
    Wire all detected tools? [Y/n] › ‹enter›

  ✓ Claude Code + Cursor + Codex connected (1.4s)


───────────────────────────────────────────────────────
🌱 One last thing — let's prove it works.

    Tell Klio one thing your AI should always know about you.

    Examples:
      · "I'm building Klio, a memory layer for AI agents"
      · "I prefer TypeScript and always want tests"
      · "Stack: Next.js 16, Postgres, Go bridge, FastAPI engine"

    Your memory › I'm Abhishek, building Klio…

    Saving…                             ✓ stored as fact (id: 7a2c…)
    Quick recall sanity check…          ✓ found, score 0.92


───────────────────────────────────────────────────────
🪄 Now open Claude Code in any project and ask:

       "What do you know about me?"

    Claude will use the klio recall tool and tell you back exactly
    what you just typed — pulled from your local engine.

    [press enter when you've seen it work, or ctrl-c if it didn't]


    ✓ Confirmed.

    Persistence test: close that Claude session, open a fresh one,
    ask again. The memory is still there. That's the point.


───────────────────────────────────────────────────────
Klio is open-source and community-built. If this saved you even
an ounce of friction:

    Star us on GitHub?    [Y/n] › ‹enter›
      ✓ opened github.com/klio-tech/klio in your browser

    Join the Discord?     [Y/n] › ‹enter›
      ✓ opened discord.gg/xRRPnW3fN2 in your browser


───────────────────────────────────────────────────────
You're all set.

    Dashboard:  http://127.0.0.1:3000
    Logs:       npx @klio-tech/klio logs
    Stop:       npx @klio-tech/klio down
```

## Banner

Lives in `npm/src/banner.ts`, printed at the top of every CLI run
that has multi-step output (`init`, `down`, `uninstall`). Skip for
`status` (which produces JSON) and `version` (one line).

```
   ▔▔▔▔▔
     ▔▔▔     klio
   ▔▔▔▔▔     <one-line context-specific subtitle>
```

Subtitles per command:

- `init` — "give every AI agent a memory they share"
- `down` — "stopping the stack — your memories are safe on disk"
- `uninstall` — "removing Klio — your agent configs are restored"

## Provider step — validation logic

All three calls go to `https://openrouter.ai/api/v1`. We use Node's
built-in `fetch` (Node 20+); zero added dependencies.

| Step | Endpoint | Success | Failure handling |
|---|---|---|---|
| Key probe | `GET /auth/key` with `Authorization: Bearer <key>` | 200 + `{data: {label, limit_remaining}}` → display label + remaining credit | 401 → "Invalid key", retry. 402 → "Out of credit", retry. 5xx → "OpenRouter unreachable", retry. |
| Embedding probe | `POST /embeddings` with `{model, input: "ok"}` | 200 + `{data: [{embedding: [...]}]}` → record dim from `embedding.length` | 404 → "Model not found", retry. 400 → display `error.message`, retry. |
| Extraction probe | `POST /chat/completions` with `{model, messages: [{role:"user",content:"ok"}], max_tokens: 1}` | 200 + `{choices: [{message: {content: "..."}}]}` → display response time | 404/400 → display error, retry. |

**Cost display.** Each successful call returns `usage.total_tokens` in
the response body. We multiply by OpenRouter's listed price for that
model (fetched once at the start via `GET /models` — cached for the
session). If the price isn't returned (some models don't surface it),
we omit the cost line and proceed.

**Retry UX.** On failure we re-prompt with the same default. The user
can keep trying; ctrl-C aborts the entire init. We don't auto-fall back
to other models — explicit > clever.

**Cost cap.** The orchestrator counts total cost across the session; if
it ever exceeds $0.01 (50× expected), abort with "test cost exceeded
$0.01 — something's wrong, aborting" and recommend the user check the
OpenRouter dashboard. Defends against a runaway loop where a buggy
validation makes 1000 paid calls.

## Forced wow moment

After tools wire up, the CLI asks the user for one memory:

```typescript
const memory = await prompt({
  message: "Your memory",
  multiline: true,           // accept up to 5 lines
  required: true,            // empty input re-prompts
});
```

Then:

1. POST `/v1/entries` with the engine using the user's refresh token
   (we kept it from the provision step). Body:
   ```json
   {
     "space_id": "<default-space>",
     "kind": "preference",
     "content": "<user's text>",
     "metadata": { "source": "klio init wow moment" },
     "confidence": 1.0
   }
   ```
2. Display the resulting entry ID (truncated) so the user can find it
   in the dashboard.
3. Sanity-check recall: POST `/v1/spaces/<id>/recall` with
   `{ query: "what should you remember about me", limit: 1 }`. The
   top result should be the entry we just wrote (cosine ≥ 0.85).
   If not, warn but proceed — recall might be quirky on a single-
   entry corpus.
4. Print the "now open Claude Code and ask…" instruction.
5. Wait on a press-enter gate. We do not try to auto-detect that
   Claude Code actually queried us — too many ways for that to be
   flaky on a fresh machine.

## Tool detection + Codex adapter

**Detection.** The npm package iterates the adapter list and asks
each `installed()`. Output displays found vs. not-found:

```
    Found:    Claude Code, Cursor, Codex
```

If none are found:

```
    No MCP-capable agents detected on this machine.
    Klio will still run; install Claude Code, Cursor, or Codex
    and re-run `npx @klio-tech/klio init` to wire them up.
```

**Codex adapter (TS).** Codex CLI uses
`~/.codex/config.toml` for MCP server config:

```toml
[mcp_servers.klio]
command = "docker"
args = ["exec", "-i", "klio-bridge", "klio-mcp"]

[mcp_servers.klio.env]
KLIO_DOCKER_BRIDGE = "klio-bridge"
```

Implementation choice: hand-roll a minimal TOML reader/writer for
the subset we need (~80 LOC) rather than add a dependency. We only
need to: parse top-level tables, find `[mcp_servers.klio]`, replace
that block (preserving everything else byte-for-byte). No need to
fully parse arrays of tables, inline tables, etc. — Codex's config
schema is flat enough.

Backup-on-write semantics same as Claude Code / Cursor adapters.

**Codex adapter (Go).** Mirror in
`bridge/internal/agentadapters/codex.go`. Use `pelletier/go-toml/v2`
on the Go side (mature, ~30KB, already a transitive dep of many of
our other deps so no new tree). Cleaner than hand-rolling in Go.

## Open URLs

`npm/src/open-url.ts`:

```typescript
import { spawn } from "node:child_process";
import { platform } from "node:os";

export function openUrl(url: string): void {
  const cmd =
    platform() === "darwin" ? "open"
    : platform() === "win32" ? "start"
    : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}
```

The community-asks step calls this if the user accepts. We don't
verify the URL actually opened (browsers swallow exit codes); we
just print "✓ opened <url> in your browser" and trust the platform.

## Engine-side changes

LiteLLM already supports OpenRouter via `openrouter/<model>` prefix
for chat completions. **Verify** it also supports embeddings — our
implementation plan must include a smoke test that calls the engine
with `KLIO_EMBEDDING_MODEL=openrouter/openai/text-embedding-3-small`
and confirms a real embedding returns. If LiteLLM falls short on
embeddings, fallback is a thin wrapper in
`engine/src/klio_engine/services/embeddings.py` that detects
`openrouter/` prefix and calls OpenRouter directly via httpx.

No schema or migration changes. The engine's existing
`embedding_dim` per-space column already handles arbitrary
dimensions (768, 1024, 1536, 3072), so swapping models is a config
change, not a database change.

## File changes summary

**npm package:**

| File | Change |
|---|---|
| `npm/src/banner.ts` | NEW: ASCII banner + per-command subtitle |
| `npm/src/prompt.ts` | NEW: interactive readline prompts (key-masked, default-shown, validated) |
| `npm/src/openrouter.ts` | NEW: 3 probe functions + cost helper |
| `npm/src/wow.ts` | NEW: forced wow moment step |
| `npm/src/community.ts` | NEW: star + Discord asks |
| `npm/src/open-url.ts` | NEW: cross-platform URL opener |
| `npm/src/adapters/codex.ts` | NEW: TOML adapter + tests |
| `npm/src/adapters/types.ts` | Add Codex to `All()` |
| `npm/src/commands/init.ts` | Rewrite: insert provider step + tool-detection-with-confirm + wow + community |
| `npm/src/compose.ts` | Add `KLIO_OPENROUTER_API_KEY`, `KLIO_EMBEDDING_MODEL`, `KLIO_EXTRACTION_MODEL` to env block |
| `npm/package.json` | Bump to `0.2.0` |

**Bridge (Go):**

| File | Change |
|---|---|
| `bridge/internal/agentadapters/codex.go` | NEW: Codex adapter |
| `bridge/internal/agentadapters/codex_test.go` | NEW: tests |
| `bridge/internal/agentadapters/types.go` | Add Codex to `All()` |

**Engine:**

| File | Change |
|---|---|
| `engine/src/klio_engine/services/embeddings.py` | Verify OpenRouter via LiteLLM; thin wrapper if needed |
| `engine/src/klio_engine/config.py` | Add `openrouter_api_key: str \| None = None` |

## Testing

- **Unit (npm):** Codex TOML round-trip, OpenRouter probes against a
  mock fetch, prompt parsing.
- **Unit (bridge):** Codex adapter idempotency + backup/restore.
- **Integration:** Run the full `klio init` against the real
  OpenRouter API in a sandboxed CI account; cap test cost at $0.005
  per run.
- **End-to-end:** Manual smoke test on a fresh user account before
  cutting `0.2.0` — full flow including the press-enter gate.

## Open questions / risks

1. **OpenRouter embeddings via LiteLLM.** Need to verify support.
   Implementation plan must include the smoke test as task 1; if it
   fails, we add a thin direct-HTTP wrapper. ~60 min of work either way.
2. **TOML parser footprint (npm).** Hand-roll vs. add `@iarna/toml`.
   Hand-roll wins on closure size + supply-chain risk; loses on
   robustness against weird Codex configs. Decision: hand-roll, with a
   well-tested minimal parser that errors loudly on edge cases rather
   than silently mis-parsing. Worst case the user sees "couldn't parse
   ~/.codex/config.toml — please file a bug" and we ship a fix.
3. **Cost-cap edge case.** If OpenRouter changes their `usage` shape,
   our cost calculation breaks gracefully (omits cost, doesn't crash),
   but the cost-cap defence relies on per-call cost being measurable.
   Acceptable risk; OpenRouter's API has been stable for >12 months.
4. **The press-enter gate is dumb.** A user who lies and presses enter
   without testing recalls a "confirmed" state that's not actually
   confirmed. We accept this; the alternative (audit-log polling) is
   flaky. The persistence-test suggestion that follows nudges the
   honest user toward real verification anyway.

## Rollout

`0.2.0` ships everything above as a single release. The `0.1.x`
line is sunset — `npx @klio-tech/klio init` resolves to `latest` =
`0.2.0` from day one. Image tags `:0.2.0` and `:latest` re-publish
the engine + bridge + trust-app via the existing CI workflow on
the version bump.
