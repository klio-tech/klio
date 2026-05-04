# OpenCode + OpenClaw adapters — design

**Date:** 2026-05-04
**Status:** Approved, ready for implementation plan
**Target release:** `0.4.1`

## Why this exists

`@klio-tech/klio@0.4.0` ships four adapters: Claude Code, Claude Desktop
(Chat + Cowork), Cursor, Codex. Two more agents the user wants Klio to
support out of the box:

- **OpenCode** (https://opencode.ai, MIT-licensed by SST). Open-source
  TUI/IDE-flavoured AI coding agent.
- **OpenClaw** (https://openclaw.ai, https://github.com/openclaw/openclaw).
  Local-first personal AI assistant that bridges messaging platforms
  (WhatsApp, Telegram, Slack, Discord, etc.) plus a coding gateway.

Both speak MCP and accept local STDIO servers, so the same
`docker exec -i klio-bridge klio-mcp` mechanism we use for the existing
four works as a transport. Only the config-file shape and write
mechanism differ.

## Goal

Two new TypeScript adapters in the npm package that:

1. **Detect** the agent on the host (config dir or CLI on PATH).
2. **Install** the klio MCP entry into the agent's config.
3. **Uninstall** it back out, restoring from a timestamped backup when
   one exists.

Both adapters get registered in `allAdapters()` so `klio init` auto-detects
them and patches their config without further user intervention.

## Non-goals

- Bridge/engine changes. The MCP shim already exposes `klio-mcp` over
  STDIO; the adapters only register WHERE that shim gets spawned.
- Per-tool auto-approval. Neither agent has a documented config-file
  equivalent of Claude Code's `permissions.allow` array. Users see a
  one-time approval prompt per tool on first invocation; they click
  "always allow" once and the agent persists that locally. If either
  agent ships a config-file always-allow later, we patch the relevant
  file in a follow-up.
- Klio Cloud. Out of scope; different repo.

## Schemas (canonical)

### OpenCode — `~/.config/opencode/opencode.json`

XDG-aware: respect `XDG_CONFIG_HOME` if set, else fall back to
`~/.config/opencode/`. Each MCP server is a sub-object under the top-
level `mcp` key.

Note the shape diff vs. Claude/Cursor: `command` is a single ARRAY
(command + args together) — NOT separate `command` string + `args`
array. Easy to get wrong; tests pin it.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "klio": {
      "type": "local",
      "command": ["docker", "exec", "-i", "klio-bridge", "klio-mcp"],
      "enabled": true
    }
  }
}
```

Field reference (per OpenCode docs at `/docs/mcp-servers`):
- `type` — `"local"` for STDIO; `"remote"` for HTTP-SSE (we always use `"local"`).
- `command` — array. Process name + args.
- `environment` — optional object. Env vars passed to the spawned process.
- `enabled` — boolean. We always emit `true`.
- `timeout` — optional, milliseconds. Default 5000. We omit (let OpenCode pick).

Detection: `~/.config/opencode/` exists. The `opencode.json` file is
created lazily by OpenCode on first config write, so we check the
parent directory.

Write mechanism: **direct JSON file write**. Mirror our existing Cursor
and Claude Desktop adapters — they write the file directly. Backup
on write, restore on uninstall.

### OpenClaw — `~/.openclaw/config.json` (via CLI)

Schema (per `https://docs.openclaw.ai/cli/mcp.md`):

```json
{
  "mcp": {
    "servers": {
      "klio": {
        "command": "docker",
        "args": ["exec", "-i", "klio-bridge", "klio-mcp"],
        "env": {}
      }
    }
  }
}
```

Field reference:
- `command` — string (executable name).
- `args` — array of arg strings.
- `env` — optional object.
- `cwd` — optional working dir; we omit.

Note: this is the same shape as Claude Code / Cursor, just nested under
`mcp.servers` instead of `mcpServers`.

Detection: `~/.openclaw/` directory exists OR `openclaw` is on PATH.

Write mechanism: **`openclaw mcp set <name> '<json>'` CLI shell-out**.
Same pattern as our existing Claude Code adapter (which uses
`claude mcp add-json`). Reasoning: the CLI is the documented
read/write contract; the file shape is internal and could change.
Using the CLI insulates us against schema migrations.

Fallback: if `openclaw` isn't on PATH but `~/.openclaw/config.json`
exists, write the JSON directly. This covers the edge case where the
user has OpenClaw installed but the binary is mounted somewhere
non-standard.

CLI invocation:

```bash
openclaw mcp set klio '{"command":"docker","args":["exec","-i","klio-bridge","klio-mcp"]}'
```

Uninstall:

```bash
openclaw mcp unset klio
```

## Architecture

Both adapters implement the existing `Adapter` interface from
`npm/src/adapters/types.ts`:

```ts
interface Adapter {
  name(): string;            // "opencode" / "openclaw"
  installed(): boolean;
  install(cfg: AdapterConfig): Promise<void>;
  uninstall(): Promise<void>;
}
```

`allAdapters()` becomes:

```ts
[
  new ClaudeCodeAdapter(),
  new ClaudeDesktopAdapter(),
  new CursorAdapter(),
  new CodexAdapter(),
  new OpenCodeAdapter(),    // NEW
  new OpenClawAdapter(),    // NEW
]
```

Init flow's narrate text (`init.ts`) updates from "Claude Code, Claude
Desktop (Chat + Cowork), Cursor, and Codex" to "Claude Code, Claude
Desktop (Chat + Cowork), Cursor, Codex, OpenCode, and OpenClaw".

The "Found:" / "Not found:" lines populate automatically — they pull
from the adapter list and check `installed()` per entry.

## File scope

| File | Type | Lines (est.) |
|---|---|---|
| `npm/src/adapters/openCode.ts` | NEW | ~80 |
| `npm/src/adapters/openClaw.ts` | NEW | ~100 (extra CLI shell-out logic) |
| `npm/tests/openCode.test.ts` | NEW | ~180, hermetic via env-var redirection |
| `npm/tests/openClaw.test.ts` | NEW | ~200 (mocked spawn for CLI) |
| `npm/src/adapters/types.ts` | edit | +2 imports, +2 entries |
| `npm/src/commands/init.ts` | edit | +1 narrate string |
| `npm/package.json` | edit | bump `0.4.0` → `0.4.1` |

No engine / bridge / compose / Dockerfile / CI workflow changes. Pure
npm-package additive work. CI will publish `@klio-tech/klio@0.4.1`
without rebuilding any container images.

## Hermetic test pattern

For OpenCode (file-based), reuse the Claude Desktop test recipe:
redirect `HOME`, `USERPROFILE`, `APPDATA`, `XDG_CONFIG_HOME` to a
fresh `tmpdir` per test. Verify install/uninstall touch only the
fake home.

For OpenClaw (CLI-based), inject a `Spawner` callback so tests don't
need the real `openclaw` binary on the test runner's PATH:

```ts
type Spawner = (cmd: string, args: string[], opts: SpawnOptions) =>
  ChildProcess | { exitCode: number; stdout: string; stderr: string };

class OpenClawAdapter implements Adapter {
  constructor(private spawner: Spawner = realSpawn) {}
  // tests construct OpenClawAdapter(fakeSpawn) and assert on captured calls
}
```

`realSpawn` wraps `node:child_process.spawn` for production use.

## Failure modes

- **OpenClaw CLI exits non-zero**: catch the error, log it, fall back
  to direct JSON write if `~/.openclaw/config.json` is writable. Last
  resort: surface a friendly error from `install()` so the init flow's
  per-adapter `try/catch` records `claudia: ${msg}` in the
  `agentsErrored` array (same pattern as today's per-adapter wiring).
- **Both `~/.openclaw/` AND `openclaw` CLI absent**: detection returns
  `false`, adapter is skipped silently. Output line in init shows
  "Not found: openclaw" alongside the other absent adapters.
- **Schema drift in either agent**: tests assert on the literal JSON
  shape we write, so a future agent update that breaks the contract
  surfaces in CI before users hit it.
- **Lock-file contention**: not relevant for either adapter — both
  config files are user-owned, written serially by `klio init`.

## Risk register

- **OpenClaw config path is INFERRED, not directly documented**. The
  docs show `~/.openclaw/gateway.token` exists but don't quote the
  exact `config.json` path. Using the CLI as the primary write
  mechanism mitigates this — the CLI handles its own pathing. The
  fallback file-write only runs when CLI is missing, in which case
  the user has likely customised their setup and will see a clear
  error.
- **OpenCode `command` array shape is unique**. Easy bug:
  `command: "docker", args: [...]` (the Claude shape) instead of
  `command: ["docker", ...]` (the OpenCode shape). One unit test
  pins this exactly to catch regressions.
- **CLI on PATH detection is racy with `installed()`**. If the user
  installs OpenClaw between `klio init`'s detection check and the
  `install()` call, we still try the CLI path and might fail. Acceptable
  — the failure surfaces in `agentsErrored` and the user re-runs.

## Testing strategy

Both adapters get the standard 8-test set + adapter-specific cases:

OpenCode (8 tests):
1. `name()` returns `"opencode"`
2. Not installed when `~/.config/opencode/` absent
3. Installed when `~/.config/opencode/` exists
4. Install creates JSON with the klio entry shaped correctly (`command` is an array)
5. Install threads `bridgeContainer` + `env` correctly
6. Install preserves peer MCP servers + unrelated keys
7. Install is idempotent (byte-for-byte equal on second run)
8. Uninstall restores from backup; strips in place when no backup

OpenClaw (10 tests):
1. `name()` returns `"openclaw"`
2. Not installed when `~/.openclaw/` absent AND no CLI
3. Installed when `~/.openclaw/` exists
4. Installed when `openclaw` CLI on PATH (no dir)
5. Install via CLI: spawner called with `mcp set klio '<json>'`
6. Install via CLI: JSON shape correct (command + args + env)
7. Install falls back to file write when CLI exits non-zero
8. Install file-write path threads bridgeContainer + env
9. Install is idempotent
10. Uninstall via CLI: spawner called with `mcp unset klio`

## Rollout

`0.4.1` is a pure npm publish — bump version, push, CI publishes.
Image-publish workflow runs but doesn't change anything (no source
under `engine/`, `bridge/`, `trust-app/`, `npm/package.json` paths
that the workflow matches… wait, `npm/package.json` IS in the paths
filter; the image workflow will retag at `:0.4.1` but the resulting
images are byte-identical to `:0.4.0`). Acceptable noise; no extra
work.

After `0.4.1` ships, `npx @klio-tech/klio@0.4.1 init` users with
OpenCode or OpenClaw installed get those agents wired automatically
in Phase 4. Existing 0.4.0 users re-run init to pick up the new
adapters; idempotent.
