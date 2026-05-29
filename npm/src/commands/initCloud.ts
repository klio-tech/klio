// Cloud-mode `klio init` — the hosted-brain onboarding path.
//
// Where the LOCAL flow (src/commands/init.ts) runs six Docker-heavy
// phases, cloud mode is three short steps:
//
//   1. Prompt for the API key.
//   2. Verify it against the hosted brain's /verify endpoint.
//   3. Wire detected agents at the hosted MCP URL (X-Vex-Key +
//      X-Vex-Agent headers) — no Docker, no hooks, no engine.
//
// Then a final reference block. The flow reuses the shared UI helpers
// (phaseHeader / runSteps / narrate) so it looks consistent with the
// local path, just dramatically shorter.
//
// Pure-orchestration with the same DI style as init.ts: prompt + fetch
// + the Claude-CLI runner are all injectable so the unit suite drives
// the flow without a TTY or the network.

import {
  CLOUD_BASE_URL,
  CLOUD_MCP_URL,
  deriveAgentId,
  maskKey,
  verifyCloudKey,
} from "../cloud.js";
import { writeCloudConfig, type CloudConfig } from "../cloudConfig.js";
import { phaseHeader, phaseRecap } from "../ui.js";
import { prompt } from "../prompt.js";
import {
  wireCloudAgents,
  type ClaudeCliFn,
} from "./wireCloudAgents.js";

/**
 * Maximum API-key re-prompts before we abort cloud init. Generous for
 * honest paste mistakes, tight enough that a non-interactive stdin
 * (no TTY, EOF stream) doesn't spin forever. On exhaustion we print a
 * clear message and return — init does not crash.
 */
const MAX_KEY_ATTEMPTS = 5;

export type InitCloudOptions = {
  /**
   * Override the readline-backed prompt. Tests inject a scripted async
   * function; production leaves this undefined and the flow falls back
   * to the standard `prompt` helper (masked input for the key).
   */
  promptFn?: (opts: {
    message: string;
    default?: string;
    mask?: boolean;
  }) => Promise<string>;
  /**
   * Override the global `fetch` used by key verification. Production
   * leaves this undefined and uses the runtime fetch; tests pass a
   * recording stub so they never hit mcp.klio.tech.
   */
  fetchFn?: typeof fetch;
  /**
   * Override the Claude-CLI runner threaded into `wireCloudAgents`.
   * Tests inject a recording stub; production leaves it undefined and
   * the real `claude` binary is spawned.
   */
  claudeCliFn?: ClaudeCliFn;
  /**
   * Override the cloud-config persister. Production leaves this undefined
   * and the verified key + agent id are written to ~/.klio/config.json so
   * the `klio hook` passive-capture client can authenticate on every
   * Claude Code event (it runs as a bare subprocess with no other access
   * to the key). Tests inject a stub so the suite never writes to the real
   * home dir.
   */
  writeConfigFn?: (config: CloudConfig) => void;
  /** Single-line writer. Defaults to stdout. */
  log?: (line: string) => void;
};

/**
 * Run the cloud onboarding flow. Returns when wiring completes (or the
 * user aborts on an unrecoverable verification failure). Never throws
 * on a user-input branch; transport failures are surfaced as
 * messages, not exceptions.
 */
export async function initCloud(opts: InitCloudOptions = {}): Promise<void> {
  const log = opts.log ?? writeLine;
  const promptFn =
    opts.promptFn ??
    ((o: { message: string; default?: string; mask?: boolean }) =>
      prompt({ message: o.message, default: o.default, mask: o.mask }));

  // -----------------------------------------------------------------
  // Phase 1 / 2 · Verify your key
  // -----------------------------------------------------------------
  phaseHeader(1, 2, "Verify your key");
  log("");
  log("  Klio Cloud stores memory on our hosted brain — no Docker, no");
  log("  local engine. Paste the API key from your Klio Cloud dashboard.");
  log("");

  const key = await promptAndVerifyKey(promptFn, opts.fetchFn, log);
  if (!key) {
    // promptAndVerifyKey already explained why (missing scope, or the
    // attempt cap was hit). Cloud init can't proceed without a valid
    // key, so we return cleanly rather than wiring agents at a brain
    // they can't reach.
    return;
  }
  phaseRecap("Phase 1 done — key verified.");

  // -----------------------------------------------------------------
  // Phase 2 / 2 · Wire your agents
  // -----------------------------------------------------------------
  phaseHeader(2, 2, "Wire your agents");
  const agentId = deriveAgentId();

  // Persist the verified key + agent id BEFORE wiring so the capture hooks
  // we're about to install (and the `klio hook` client they invoke) can
  // authenticate immediately on the very first Claude Code event.
  const writeConfigFn = opts.writeConfigFn ?? writeCloudConfig;
  writeConfigFn({ apiKey: key, agentId, baseUrl: CLOUD_BASE_URL });

  log("");
  log(`    Pointing your agents at ${CLOUD_MCP_URL}`);
  log(`    Agent id: ${agentId}`);
  log("");

  const result = await wireCloudAgents({
    apiKey: key,
    agentId,
    log,
    claudeCliFn: opts.claudeCliFn,
  });

  for (const e of result.errored) {
    log(`  ! ${e.name}: ${e.message}`);
  }
  if (result.configured.length > 0) {
    log(`  ✓ ${result.configured.join(" + ")} connected`);
  } else if (result.skipped.length === 0 && result.errored.length === 0) {
    log("  — No MCP-capable agents found. Install Claude Code, Cursor, or");
    log("    Codex and re-run `klio init` to wire them up.");
  }
  phaseRecap("Phase 2 done — your agents are talking to Klio Cloud.");

  printReferenceBlock(log, result.configured, key);
}

/**
 * Prompt for the API key and verify it, looping on recoverable
 * failures. Returns the verified key, or `null` when the flow should
 * abort (missing scope, attempt cap reached, or repeated network
 * failure the user declined to retry).
 *
 * Branches per the /verify contract:
 *   - valid         → return the key (optionally noting org_id).
 *   - missing_scope → explain + abort (a new key with the `memory`
 *                     scope is needed; re-prompting the same key is
 *                     pointless, but the user can supply a different
 *                     one, so we re-prompt within the attempt cap).
 *   - invalid       → "key invalid", re-prompt.
 *   - network_error → surface the error, ask retry/abort.
 */
async function promptAndVerifyKey(
  promptFn: (opts: {
    message: string;
    default?: string;
    mask?: boolean;
  }) => Promise<string>,
  fetchFn: typeof fetch | undefined,
  log: (line: string) => void,
): Promise<string | null> {
  const verify = (k: string) => verifyCloudKey(k, fetchFn ?? globalThis.fetch);

  for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++) {
    const raw = await promptFn({ message: "API key", mask: true });
    const key = raw.trim();
    if (!key) {
      log("  ! API key can't be empty.");
      continue;
    }

    const result = await verify(key);
    switch (result.kind) {
      case "valid":
        log(
          `  ✓ Key verified (${maskKey(key)})` +
            (result.orgId ? ` — org ${result.orgId}` : ""),
        );
        return key;
      case "missing_scope":
        log(
          `  ! That key is valid but lacks the \`memory\` scope (${maskKey(key)}) —`,
        );
        log(
          "    it can't access the Klio brain. Mint a key with the `memory`",
        );
        log("    scope from your dashboard, then paste it here.");
        continue;
      case "invalid":
        log(`  ! Key invalid (${maskKey(key)}) — check it and try again.`);
        continue;
      case "network_error": {
        log(`  ! Couldn't reach the Klio brain: ${result.message}`);
        const retry = await promptFn({
          message: "Retry? [Y/n]",
          default: "Y",
        });
        const ans = retry.trim().toLowerCase();
        if (ans === "n" || ans === "no") {
          log("  — Aborted. Re-run `klio init` once you're back online.");
          return null;
        }
        // Any other answer (including the default) retries — but the
        // retry re-prompts for the key too, since the prior paste may
        // be the problem. We `continue` WITHOUT consuming a fresh
        // attempt for a transient network blip would be ideal, but the
        // attempt cap is the only guard against an infinite loop on a
        // permanently-offline machine, so we let the loop advance.
        continue;
      }
    }
  }

  log(
    "  — Couldn't verify a key after several attempts. Re-run `klio init`",
  );
  log("    with a valid Klio Cloud API key (with the `memory` scope).");
  return null;
}

/**
 * Final reference block printed after wiring. Lists the connected
 * agents, the cloud URL, and a one-liner that memory now persists to
 * Klio Cloud. No dashboard URL — cloud has none yet. The key is shown
 * masked only (last 4) so it never lands in scrollback in full.
 */
function printReferenceBlock(
  log: (line: string) => void,
  configured: string[],
  key: string,
): void {
  log("");
  log("Klio Cloud is ready.");
  log("");
  if (configured.length > 0) {
    log(`  Connected agents:  ${configured.join(", ")}`);
  }
  log(`  Memory endpoint:   ${CLOUD_MCP_URL}`);
  log(`  Authenticated as:  key ${maskKey(key)}`);
  log("");
  log("  Your agents now read and write memory to Klio Cloud — it");
  log("  persists across sessions, machines, and restarts.");
  log("");
}

function writeLine(line: string): void {
  process.stdout.write(line + "\n");
}
