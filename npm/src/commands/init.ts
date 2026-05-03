// `klio init` — the user-facing onboarding flow.
//
// Sequence (left-to-right is strict; each step depends on the
// artifacts of the one before):
//
//   1. Banner
//   2. Preflight Docker (installed + daemon reachable)
//   3. Provider setup (OpenRouter key + embedding/extraction models)
//      — happens BEFORE compose/pull/up so the engine boots once,
//      already pointed at the right LLM stack. The alternative —
//      generate placeholder env, pull, prompt mid-flow, rewrite env,
//      restart — would force the engine to restart between steps and
//      stall the long compose-pull behind an interactive prompt the
//      user can't see coming.
//   4. Write ~/.klio/runtime/{docker-compose.yml, .env}
//   5. docker compose pull   (so subsequent `up` is fast)
//   6. docker compose up -d  (postgres, redis, engine, bridge)
//   7. Wait for engine /health
//   8. Provision an account against the local engine (HTTP)
//   9. Persist credentials inside the bridge container
//      (`docker exec klio-bridge klio configure ...`)
//  10. Tool detection — show what we found, confirm before patching
//  11. Patch Claude Code + Cursor + Codex configs (if confirmed)
//  12. Refresh env file with the user/agent IDs (so trust-app's
//      auto-login works on first boot)
//  13. Bring up the trust-app dashboard
//  14. Wow moment — write a memory + recall it back to prove the loop
//  15. Community asks — star + Discord
//  16. Print final reference block
//
// Whole flow is idempotent: re-running reuses the install_id, gets
// the same user_id back, and re-applies agent configs — useful for
// repairing a broken install.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { renderBanner } from "../banner.js";
import { info, runSteps, type Step } from "../ui.js";
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
import { allAdapters, type Adapter } from "../adapters/types.js";
import { prompt } from "../prompt.js";
import { setupProvider, type ProviderConfig } from "../providerSetup.js";
import {
  probeKey,
  probeEmbeddingModel,
  probeChatModel,
} from "../openrouter.js";
import { runWowMoment } from "../wow.js";
import { runCommunityAsks } from "../community.js";
import { openUrl } from "../openUrl.js";

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
  /**
   * Skip the OpenRouter provider step. For tests + repair flows on a
   * machine that already has a valid `.env` from a prior install. The
   * default flow always runs the provider step so a brand-new user
   * cannot end up with an engine that boots without an LLM key.
   */
  skipProvider?: boolean;
  /**
   * Skip the wow-moment write+recall demo. Provided so CI / smoke
   * tests can run `init` end-to-end without a TTY for the multiline
   * memory prompt.
   */
  skipWow?: boolean;
  /**
   * Skip the GitHub-star + Discord community asks at the end of
   * init. Provided so non-interactive runs don't hang on a y/n
   * prompt when stdin isn't a TTY.
   */
  skipCommunity?: boolean;
};

export async function init(opts: InitOptions): Promise<void> {
  process.stdout.write(renderBanner("init") + "\n");

  const engineURL = opts.engineURL ?? ENGINE_URL;
  const composeFile = join(runtimeDir(), "docker-compose.yml");
  const envFile = join(runtimeDir(), ".env");

  // We assemble per-run state in this scope so each step can write
  // fields the next step reads. (Avoid module-level mutable state —
  // makes the flow easier to reason about and to test.)
  const state: {
    composeBin?: Awaited<ReturnType<typeof resolveComposeBin>>;
    signingKey: string;
    provider?: ProviderConfig;
    userID?: string;
    agentID?: string;
    defaultSpaceID?: string;
    refreshToken?: string;
    detectedAdapters: Adapter[];
    adaptersConfigured: string[];
    adaptersErrored: string[];
    adaptersSkipped: boolean;
  } = {
    signingKey: existingSigningKey(envFile) ?? generateSigningKey(),
    detectedAdapters: [],
    adaptersConfigured: [],
    adaptersErrored: [],
    adaptersSkipped: false,
  };

  const installID = getOrCreateInstallId();

  const preProviderSteps: Step[] = [
    {
      title: "Check Docker is installed and running",
      run: async () => {
        const status = await preflightDocker();
        state.composeBin = await resolveComposeBin();
        return { kind: "ok", status };
      },
    },
  ];

  const postProviderSteps: Step[] = [
    {
      title: "Generate compose file at ~/.klio/runtime/",
      run: async () => {
        writeComposeFile({
          imageTag: opts.imageTag,
          jwtSigningKey: state.signingKey,
          embeddingModel: state.provider?.embeddingModel,
          extractionModel: state.provider?.extractionModel,
        });
        // Minimum env needed for compose's variable interpolation.
        // user/agent IDs are filled in after provisioning (below).
        writeEnvFile({
          KLIO_JWT_SIGNING_KEY: state.signingKey,
          KLIO_OPENROUTER_API_KEY: state.provider?.openrouterKey ?? "",
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
  ];

  const postWireSteps: Step[] = [
    {
      title: "Refresh local-dev env file with your IDs",
      run: async () => {
        writeEnvFile({
          KLIO_JWT_SIGNING_KEY: state.signingKey,
          KLIO_OPENROUTER_API_KEY: state.provider?.openrouterKey ?? "",
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

  // 1. Docker preflight first so the user gets a fast "install
  //    Docker" error before we ask them for an API key.
  await runSteps(preProviderSteps);

  // 2. Provider setup — interactive, runs outside the runSteps UI
  //    because the prompts need to drive their own readline cycle
  //    and the spinner-style step UI would conflict with line input.
  if (!opts.skipProvider) {
    state.provider = await runProviderSetup();
  }

  // 3. Compose + pull + up + provision + keychain configure.
  await runSteps(postProviderSteps);

  // 4. Adapter detection + interactive confirm. Lives outside
  //    runSteps for the same reason as the provider step — the
  //    [Y/n] prompt drives its own readline.
  await runAdapterStep(state);

  // 5. Refresh env + start trust-app.
  await runSteps(postWireSteps);

  for (const e of state.adaptersErrored) {
    process.stderr.write(`! ${e}\n`);
  }

  // 6. Wow moment — only meaningful once trust-app is up and the
  //    engine has the user's refresh token in hand. Skipped on
  //    --skip-wow (tests / CI).
  if (
    !opts.skipWow &&
    state.refreshToken &&
    state.defaultSpaceID
  ) {
    await runWowStep({
      engineURL,
      refreshToken: state.refreshToken,
      spaceID: state.defaultSpaceID,
    });
  }

  // 7. Community asks — runs after the wow moment, when the user
  //    has just experienced the value, so a Yes is meaningful.
  if (!opts.skipCommunity) {
    await runCommunityAsks({
      promptFn: (o) => prompt({ message: o.message, default: o.default }),
      openUrlFn: openUrl,
      log: writeLine,
    });
  }

  process.stdout.write("\n");
  process.stdout.write("Klio is ready.\n\n");
  process.stdout.write(`  Open the dashboard:  ${TRUST_APP_URL}\n`);
  process.stdout.write(`  Inspect status:      npx @klio-tech/klio status\n`);
  process.stdout.write(`  Stop the stack:      npx @klio-tech/klio down\n`);
}

/**
 * Drive the OpenRouter provider setup. Prints a section header so
 * the user knows we've left the docker-preflight phase and entered
 * the interactive part. The actual prompt loop lives in
 * `providerSetup.ts`.
 */
async function runProviderSetup(): Promise<ProviderConfig> {
  process.stdout.write("\n");
  process.stdout.write("▸ Connect your LLM provider (OpenRouter)\n");
  process.stdout.write(
    "    Klio uses OpenRouter to route embedding + extraction\n",
  );
  process.stdout.write(
    "    calls to the model of your choice. Get a key at\n",
  );
  process.stdout.write("    https://openrouter.ai/keys\n\n");
  return setupProvider({
    promptFn: (o) =>
      prompt({ message: o.message, default: o.default, mask: o.mask }),
    probeKey,
    probeEmbedding: probeEmbeddingModel,
    probeChat: probeChatModel,
    log: writeLine,
  });
}

/**
 * Detect installed agent adapters, print the list, and confirm
 * before patching their configs. Mutates `state` with results so
 * the caller can surface errors after `runSteps` finishes.
 */
async function runAdapterStep(state: {
  detectedAdapters: Adapter[];
  adaptersConfigured: string[];
  adaptersErrored: string[];
  adaptersSkipped: boolean;
}): Promise<void> {
  process.stdout.write("\n");
  process.stdout.write("▸ Detecting your AI tools…\n");
  const detected = allAdapters().filter((a) => a.installed());
  state.detectedAdapters = detected;

  if (detected.length === 0) {
    process.stdout.write(
      "    No MCP-capable agents found. Install Claude Code, Cursor, or\n",
    );
    process.stdout.write(
      "    Codex and re-run `klio init` to wire them up.\n",
    );
    return;
  }

  const names = detected.map((a) => a.name()).join(", ");
  process.stdout.write(`    Found:    ${names}\n`);

  const answer = await prompt({
    message: "Wire all detected tools?",
    default: "Y",
  });
  if (!isYes(answer)) {
    state.adaptersSkipped = true;
    process.stdout.write(
      "    Skipped — re-run `klio init` to wire them.\n",
    );
    return;
  }

  for (const adapter of detected) {
    try {
      await adapter.install({
        bridgeContainer: BRIDGE_CONTAINER,
        env: {},
      });
      state.adaptersConfigured.push(adapter.name());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.adaptersErrored.push(`${adapter.name()}: ${msg}`);
    }
  }

  if (state.adaptersConfigured.length > 0) {
    process.stdout.write(
      `  ✓ ${state.adaptersConfigured.join(" + ")} connected\n`,
    );
  }
}

/**
 * Run the wow moment. Wraps the `prompt` module to satisfy the
 * `WowDeps.promptFn` shape (multiline input) and provides a thin
 * `waitEnter` helper that blocks until the user presses Enter.
 */
async function runWowStep(args: {
  engineURL: string;
  refreshToken: string;
  spaceID: string;
}): Promise<void> {
  await runWowMoment({
    engineURL: args.engineURL,
    refreshToken: args.refreshToken,
    spaceID: args.spaceID,
    promptFn: (o) =>
      prompt({ message: o.message, multiline: o.multiline ?? false }),
    log: writeLine,
    // Block until Enter is pressed. We accept any input — we don't
    // care what the user types here, only that they hit Enter once
    // they've confirmed Claude Code surfaced the memory back.
    waitEnter: async () => {
      await prompt({ message: "", default: " " });
    },
  });
}

/**
 * Treats empty / "y" / "yes" (any case, with surrounding whitespace)
 * as acceptance. Mirrors the rule in `community.ts` so the two
 * y/n prompts behave consistently.
 */
function isYes(answer: string): boolean {
  const t = answer.trim().toLowerCase();
  return t === "" || t === "y" || t === "yes";
}

function writeLine(line: string): void {
  process.stdout.write(line + "\n");
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
