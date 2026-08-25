// `klio quickstart` — the whole Klio surface in one plain-text dump.
//
// Written for two readers at once: a human skimming a terminal, and a
// CODING AGENT that was told "connect yourself to Klio" and needs the
// concept map, the tool list, and a ready-to-paste config snippet for
// its own host without a browser. So the output is deterministic
// (no timestamps, no detection, no network), plain text (no ANSI), and
// uses an explicit placeholder wherever a real API key would go.
//
// Deliberately NOT generated from the adapters: the snippets here are
// documentation of the on-disk shapes the cloud writers
// (src/commands/wireCloudAgents.ts) produce, stated for a reader who
// will apply them by hand or by agent. If a writer's shape changes,
// change the matching snippet here — the tests pin both.

import { CLOUD_MCP_URL, VEX_AGENT_HEADER, VEX_KEY_HEADER } from "../cloud.js";

/**
 * Placeholder used in every config snippet where the user's API key
 * belongs. All-caps and self-describing so an agent substituting it
 * cannot mistake it for a real credential — and a human pasting a
 * snippet unedited gets a clean 401 instead of a silent misconfig.
 */
const KEY_PLACEHOLDER = "YOUR_KLIO_API_KEY";

/**
 * Placeholder for the per-machine agent id. `klio init` derives the
 * real value from the hostname (see `deriveAgentId` in src/cloud.ts);
 * a hand-wired agent can use any stable identifier.
 */
const AGENT_PLACEHOLDER = "your-machine-name";

/**
 * The full quickstart text. Pure and deterministic — same output every
 * call, no environment reads — so tests can pin phrases and an agent
 * can cache it.
 */
export function quickstartText(): string {
  return `KLIO QUICKSTART
===============

Klio is persistent, shared memory for AI agents. Your agent connects to
one MCP server and gets recall + write tools over everything you and
your team have taught it.

  Endpoint:  ${CLOUD_MCP_URL}   (MCP, streamable HTTP)
  Auth:      \`${VEX_KEY_HEADER}\` header — your API key
  Identity:  \`${VEX_AGENT_HEADER}\` header — a stable per-machine/agent id

CONCEPTS
--------

  personal node   Your private brain (@username). Everything captured in
                  private scope lands here; only you can read it.
  org nodes       Workspaces you join. Memory shared with your team
                  lives on the org node.
  projects        A workspace project linked to the engine (git-keyed
                  capture): work inside the repo is attributed to the
                  project automatically.
  context branches  Git-branch-bound drafts of memory. Writes on a
                  branch stay on it until you merge them into the main
                  context or discard them — like a git branch for what
                  the agent learned.
  scopes          Capture is PRIVATE by default. \`remember\` writes to
                  the org. Project writes are explicit. share() promotes
                  an existing private memory to a wider scope.

MCP TOOLS
---------

  Reading:   recall (search memory), space (where am I / what nodes)
  Writing:   remember (durable fact -> org), decide (a decision),
             plan (a plan), note (other durable context),
             observe (an observation), forget (retract by id),
             share (promote a private memory to a wider scope)
  Projects:  project_create, project_list, project_members,
             project_grant, project_scope, project_link
  Branches:  branch(create|list|info|merge|discard)
  Coordination: claim (register intent before starting work),
             release (done — drop the claim)
  Artifacts: artifact_get, artifact_put

CLI COMMANDS
------------

  klio init --key <token>   Verify the key, wire every detected agent,
                            finish with a live verification probe.
                            (Key also read from KLIO_API_KEY.)
  klio status               Key configured? Which files carry it, the
                            masked key, last verification result.
  klio doctor               Check the proxy end to end; repair what it can.
  klio quickstart           This text.
  klio uninit               Remove proxy wiring (memory untouched).
  klio uninstall            Remove everything; restore config backups.

CONNECT AN AGENT BY HAND
------------------------

Prefer \`klio init --key <token>\` — it writes all of the below for every
agent it detects. The shapes, for wiring one host manually
(replace ${KEY_PLACEHOLDER} with your API key from the Klio dashboard,
and ${AGENT_PLACEHOLDER} with any stable machine identifier):

claude-code (registered via the Claude CLI into ~/.claude.json):

  claude mcp add-json --scope user klio '{
    "type": "http",
    "url": "${CLOUD_MCP_URL}",
    "headers": {
      "${VEX_KEY_HEADER}": "${KEY_PLACEHOLDER}",
      "${VEX_AGENT_HEADER}": "${AGENT_PLACEHOLDER}"
    }
  }'

claude-desktop (claude_desktop_config.json — stdio only, so it goes
through the mcp-remote bridge):

  {
    "mcpServers": {
      "klio": {
        "command": "npx",
        "args": [
          "-y", "mcp-remote", "${CLOUD_MCP_URL}",
          "--header", "${VEX_KEY_HEADER}: ${KEY_PLACEHOLDER}",
          "--header", "${VEX_AGENT_HEADER}: ${AGENT_PLACEHOLDER}"
        ]
      }
    }
  }

codex (~/.codex/config.toml):

  [mcp_servers.klio]
  url = "${CLOUD_MCP_URL}"

  [mcp_servers.klio.http_headers]
  "${VEX_KEY_HEADER}" = "${KEY_PLACEHOLDER}"
  "${VEX_AGENT_HEADER}" = "${AGENT_PLACEHOLDER}"

cursor (~/.cursor/mcp.json):

  {
    "mcpServers": {
      "klio": {
        "url": "${CLOUD_MCP_URL}",
        "headers": {
          "${VEX_KEY_HEADER}": "${KEY_PLACEHOLDER}",
          "${VEX_AGENT_HEADER}": "${AGENT_PLACEHOLDER}"
        }
      }
    }
  }

Then verify:  klio status
Learn more:   https://klio.tech`;
}

/** Injectable sink so tests capture output without touching stdout. */
export type QuickstartOptions = {
  write?: (chunk: string) => void;
};

/** Print the quickstart text. */
export function runQuickstart(opts: QuickstartOptions = {}): void {
  const write =
    opts.write ?? ((chunk: string) => process.stdout.write(chunk));
  write(quickstartText() + "\n");
}
