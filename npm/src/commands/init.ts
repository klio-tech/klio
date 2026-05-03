// `klio init` — the user-facing onboarding flow.
//
// Sequence:
//
//   1. Preflight Docker (installed + daemon reachable)
//   2. Write ~/.klio/runtime/{docker-compose.yml, .env}
//   3. docker compose pull   (so subsequent `up` is fast)
//   4. docker compose up -d  (postgres, redis, engine, bridge)
//   5. Wait for engine /health
//   6. Provision an account against the local engine (HTTP)
//   7. Persist credentials inside the bridge container
//      (`docker exec klio-bridge klio configure ...`)
//   8. Patch Claude Code + Cursor configs
//   9. Bring up the trust-app dashboard
//
// Steps 5–9 are gated on the previous one succeeding because each
// builds on the artifacts of the one before. Steps 1–4 are also
// strictly ordered. Whole flow is idempotent: re-running reuses
// the install_id, gets the same user_id back, and re-applies agent
// configs — useful for repairing a broken install.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { banner, info, runSteps, type Step } from "../ui.js";
import {
  composePull,
  composeUp,
  dockerExec,
  preflightDocker,
  resolveComposeBin,
} from "../docker.js";
import {
  runtimeDir,
  writeComposeFile,
  writeEnvFile,
} from "../compose.js";
import { provision, waitForEngineHealth } from "../engine.js";
import { generateSigningKey, getOrCreateInstallId } from "../installId.js";
import { ClaudeCodeAdapter } from "../adapters/claudeCode.js";
import { CursorAdapter } from "../adapters/cursor.js";
import type { Adapter } from "../adapters/types.js";

const ENGINE_URL = "http://127.0.0.1:8000";
const TRUST_APP_URL = "http://127.0.0.1:3000";
const BRIDGE_CONTAINER = "klio-bridge";
// Agent enum value defined in
// engine/src/klio_engine/models/agent.py — must match an
// existing variant. We register the npm-launched user as
// "klio-bridge" (same as the Go-side `klio init`) because the
// daemon container is what actually performs reads/writes; the
// npm package is just the orchestrator that put it there.
const PROVISION_AGENT_KIND = "klio-bridge";

export type InitOptions = {
  /**
   * Image tag pulled for engine/bridge/trust-app. Defaults to the
   * package version baked into dist/version.js. Override via
   * --image-tag for testing pre-release tags.
   */
  imageTag: string;
  /** Optional email; engine stores it for cross-device claim later. */
  email?: string;
  /** Override engine URL (rarely needed). */
  engineURL?: string;
};

export async function init(opts: InitOptions): Promise<void> {
  banner("Setting up Klio");

  const engineURL = opts.engineURL ?? ENGINE_URL;
  const composeFile = join(runtimeDir(), "docker-compose.yml");
  const envFile = join(runtimeDir(), ".env");

  // We assemble per-run state in this scope so each step can write
  // fields the next step reads. (Avoid module-level mutable state —
  // makes the flow easier to reason about and to test.)
  const state: {
    composeBin?: Awaited<ReturnType<typeof resolveComposeBin>>;
    signingKey: string;
    userID?: string;
    agentID?: string;
    defaultSpaceID?: string;
    refreshToken?: string;
    agentsConfigured: string[];
    agentsErrored: string[];
  } = {
    signingKey: existingSigningKey(envFile) ?? generateSigningKey(),
    agentsConfigured: [],
    agentsErrored: [],
  };

  const installID = getOrCreateInstallId();

  const steps: Step[] = [
    {
      title: "Check Docker is installed and running",
      run: async () => {
        const status = await preflightDocker();
        state.composeBin = await resolveComposeBin();
        return { kind: "ok", status };
      },
    },
    {
      title: "Generate compose file at ~/.klio/runtime/",
      run: async () => {
        writeComposeFile({
          imageTag: opts.imageTag,
          jwtSigningKey: state.signingKey,
        });
        // Minimum env needed for compose's variable interpolation.
        // user/agent IDs are filled in after provisioning (below).
        writeEnvFile({
          KLIO_JWT_SIGNING_KEY: state.signingKey,
          KLIO_LOCAL_USER_ID: "",
          KLIO_LOCAL_AGENT_ID: "",
          KLIO_LOG_LEVEL: "INFO",
        });
        return { kind: "ok", status: composeFile };
      },
    },
    {
      title: "Pull container images",
      run: async () => {
        return composePull(state.composeBin!, {
          cwd: runtimeDir(),
          services: ["postgres", "redis", "engine", "bridge", "trust-app"],
        });
      },
    },
    {
      title: "Start services (postgres, redis, engine, bridge)",
      run: async () => {
        return composeUp(state.composeBin!, {
          cwd: runtimeDir(),
          services: ["postgres", "redis", "engine", "bridge"],
        });
      },
    },
    {
      title: `Wait for engine to be ready at ${engineURL}`,
      run: async () => {
        await waitForEngineHealth(engineURL);
        return { kind: "ok", status: engineURL };
      },
    },
    {
      title: "Set up your account",
      run: async () => {
        const r = await provision(engineURL, {
          agentKind: PROVISION_AGENT_KIND,
          installID,
          email: opts.email,
        });
        state.userID = r.user_id;
        state.agentID = r.agent_id;
        state.defaultSpaceID = r.default_space_id;
        state.refreshToken = r.api_key;
        info(`user_id        ${r.user_id}`);
        info(`agent_id       ${r.agent_id}`);
        info(`default space  ${r.default_space_id}`);
        return { kind: "ok", status: "account ready" };
      },
    },
    {
      title: "Persist credentials inside the bridge container",
      run: async () => {
        await dockerExec(BRIDGE_CONTAINER, [
          "klio",
          "configure",
          "--refresh-token",
          state.refreshToken!,
          "--user-id",
          state.userID!,
          "--agent-id",
          state.agentID!,
          "--default-space-id",
          state.defaultSpaceID!,
        ]);
        return { kind: "ok", status: "stored in keychain volume" };
      },
    },
    {
      title: "Wire Claude Code and Cursor",
      run: async () => {
        const adapters: Adapter[] = [
          new ClaudeCodeAdapter(),
          new CursorAdapter(),
        ];
        for (const adapter of adapters) {
          if (!adapter.installed()) continue;
          try {
            await adapter.install({
              bridgeContainer: BRIDGE_CONTAINER,
              env: {},
            });
            state.agentsConfigured.push(adapter.name());
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            state.agentsErrored.push(`${adapter.name()}: ${msg}`);
          }
        }
        if (state.agentsConfigured.length === 0 && state.agentsErrored.length === 0) {
          return {
            kind: "warn",
            message:
              "no MCP-capable agents detected on this machine — install Claude Code or Cursor and re-run",
          };
        }
        return {
          kind: "ok",
          status: state.agentsConfigured.join(", ") || "no changes",
        };
      },
    },
    {
      title: "Refresh local-dev env file with your IDs",
      run: async () => {
        writeEnvFile({
          KLIO_JWT_SIGNING_KEY: state.signingKey,
          KLIO_LOCAL_USER_ID: state.userID!,
          KLIO_LOCAL_AGENT_ID: state.agentID!,
          KLIO_LOG_LEVEL: "INFO",
        });
        return { kind: "ok", status: envFile };
      },
    },
    {
      title: "Start the dashboard (trust-app)",
      run: async () => {
        return composeUp(state.composeBin!, {
          cwd: runtimeDir(),
          services: ["trust-app"],
        });
      },
    },
  ];

  await runSteps(steps);

  for (const e of state.agentsErrored) {
    process.stderr.write(`! ${e}\n`);
  }

  process.stdout.write("\n");
  process.stdout.write("Klio is ready.\n\n");
  process.stdout.write(`  Open the dashboard:  ${TRUST_APP_URL}\n`);
  process.stdout.write(`  Inspect status:      npx @klio-tech/klio status\n`);
  process.stdout.write(`  Stop the stack:      npx @klio-tech/klio down\n`);
}

/**
 * If a previous `klio init` already wrote a JWT key, reuse it so
 * existing trust-app sessions remain valid across re-runs.
 * Returns null when no .env file exists or the key isn't found.
 */
function existingSigningKey(envFile: string): string | null {
  if (!existsSync(envFile)) return null;
  try {
    const raw = readFileSync(envFile, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^KLIO_JWT_SIGNING_KEY\s*=\s*(.+)$/);
      if (m && m[1] && m[1].length >= 32) return m[1].trim();
    }
  } catch {
    /* fall through */
  }
  return null;
}
