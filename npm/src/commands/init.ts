// `klio init` — the immersive 5-phase onboarding flow.
//
// Phases (left-to-right is strict; each phase depends on the
// artifacts of the one before):
//
//   Phase 1 / 5  ·  Preflight
//     - Check Docker is installed and running.
//
//   Phase 2 / 5  ·  Connect a model
//     - Provider menu (OpenRouter / Ollama / Custom).
//     - Provider-specific setup loop (key + model picks + probes).
//     - The Ollama branch may fall back to OpenRouter on detection
//       failure; the fallback is a control-flow signal, not an error.
//
//   Phase 3 / 5  ·  Bring up your stack
//     - Generate ~/.klio/runtime/{docker-compose.yml, .env}.
//     - Pull container images.
//     - Start postgres + redis + engine + bridge.
//     - Wait for engine /health.
//     - Provision an account against the local engine (HTTP).
//     - Persist credentials inside the bridge container.
//
//   Phase 4 / 5  ·  Wire your AI agents
//     - Detect installed agents; explicit [Y/n] confirm.
//     - Patch Claude Code + Cursor + Codex configs (if confirmed).
//     - Refresh env file with the user/agent IDs (so trust-app's
//       auto-login works on first boot).
//     - Bring up the trust-app dashboard.
//
//   Phase 5 / 5  ·  Prove it works
//     - Wow moment — write a memory + recall it back to prove the loop.
//
//   (post) Community asks — star + Discord.
//   (post) Final reference block — dashboard URL, status, down command.
//
// The whole flow is idempotent: re-running reuses the install_id, gets
// the same user_id back, and re-applies agent configs — useful for
// repairing a broken install. Provider setup happens BEFORE compose/
// pull/up so the engine boots once already pointed at the right LLM
// stack — the alternative (placeholder env, pull, prompt mid-flow,
// rewrite env, restart) would force the engine to restart between
// steps and stall the long compose-pull behind an interactive prompt
// the user can't see coming.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { renderBanner } from "../banner.js";
import {
  info,
  narrate,
  phaseHeader,
  phaseRecap,
  runSteps,
  setQuiet,
  type Step,
} from "../ui.js";
import {
  composePull,
  composeRestart,
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
import {
  setupProvider,
  setupOllama,
  setupCustom,
  type ProviderConfig,
  type OllamaConfig,
  type CustomConfig,
} from "../providerSetup.js";
import { selectProvider, type ProviderKind } from "../providerMenu.js";
import {
  probeKey,
  probeEmbeddingModel,
  probeChatModel,
} from "../openrouter.js";
import {
  isOllamaRunning,
  listInstalledModels,
  pullOllamaModel,
  getEmbedDim,
  filterToSupportedEmbed,
} from "../ollama.js";
import { runWowMoment } from "../wow.js";
import { runCommunityAsks } from "../community.js";
import { openUrl } from "../openUrl.js";
import { spawn } from "node:child_process";

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
   * Skip the provider-setup phase entirely. For tests + repair flows
   * on a machine that already has a valid `.env` from a prior install.
   * The default flow always runs the provider step so a brand-new
   * user cannot end up with an engine that boots without an LLM key.
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
  /**
   * Suppress per-step narration and phase-recap lines. The
   * structural markers (▸ start, ✓ ok, ✗ fail, phase headers)
   * still render, so the user can see the shape of the flow even
   * with quiet on. Aimed at experienced users on re-runs who don't
   * need the explanatory text. Defaults to false.
   */
  quiet?: boolean;
};

/**
 * Tagged union threading the picked provider's config through Phase 3.
 * The `kind` discriminator drives compose-env-var assembly + model-name
 * prefixing. Each variant carries the shape produced by its own setup
 * helper:
 *
 *   - openrouter: validated API key + chosen embed/extract models.
 *   - ollama:     local-only; no key, just model names + dim.
 *   - custom:     user-supplied base URL + key + model names.
 */
export type ProviderResult =
  | { kind: "openrouter"; config: ProviderConfig }
  | { kind: "ollama"; config: OllamaConfig }
  | { kind: "custom"; config: CustomConfig };

export async function init(opts: InitOptions): Promise<void> {
  process.stdout.write(renderBanner("init") + "\n");

  // Apply --quiet immediately after the banner so every narrate /
  // phaseRecap call from this point on respects the user's choice.
  // Default false preserves the standard verbose flow when the flag
  // is omitted.
  const quiet = opts.quiet ?? false;
  setQuiet(quiet);

  if (!quiet) writeWelcomePreview();

  const engineURL = opts.engineURL ?? ENGINE_URL;
  const composeFile = join(runtimeDir(), "docker-compose.yml");
  const envFile = join(runtimeDir(), ".env");

  // We assemble per-run state in this scope so each step can write
  // fields the next step reads. (Avoid module-level mutable state —
  // makes the flow easier to reason about and to test.)
  const state: {
    composeBin?: Awaited<ReturnType<typeof resolveComposeBin>>;
    signingKey: string;
    provider?: ProviderResult;
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

  // -----------------------------------------------------------------
  // Phase 1 / 5 · Preflight
  // -----------------------------------------------------------------
  phaseHeader(1, 5, "Preflight");
  await runSteps([
    {
      title: "Checking Docker is installed and running",
      run: async () => {
        narrate(
          "Docker runs your local memory stack — we don't touch your host system, everything lives in containers.",
        );
        const status = await preflightDocker();
        state.composeBin = await resolveComposeBin();
        return { kind: "ok", status };
      },
    },
  ]);
  phaseRecap("Phase 1 done.");

  // -----------------------------------------------------------------
  // Phase 2 / 5 · Connect a model
  // -----------------------------------------------------------------
  phaseHeader(2, 5, "Connect a model");
  if (!opts.skipProvider) {
    state.provider = await runProviderPhase();
  }
  phaseRecap("Phase 2 done.");

  // -----------------------------------------------------------------
  // Phase 3 / 5 · Bring up your stack
  // -----------------------------------------------------------------
  phaseHeader(3, 5, "Bring up your stack");
  await runSteps(buildStackSteps(opts, state, engineURL, composeFile, installID));
  phaseRecap(
    "Phase 3 done — engine, bridge, postgres, redis all running.",
  );

  // -----------------------------------------------------------------
  // Phase 4 / 5 · Wire your AI agents
  // -----------------------------------------------------------------
  phaseHeader(4, 5, "Wire your AI agents");
  await runAdapterStep(state);
  await runSteps(buildPostWireSteps(state, envFile));
  for (const e of state.adaptersErrored) {
    process.stderr.write(`! ${e}\n`);
  }
  phaseRecap("Phase 4 done — your agents are now talking to Klio.");

  // -----------------------------------------------------------------
  // Phase 5 / 5 · Prove it works
  // -----------------------------------------------------------------
  phaseHeader(5, 5, "Prove it works");
  if (!opts.skipWow && state.refreshToken && state.defaultSpaceID) {
    await runWowStep({
      engineURL,
      refreshToken: state.refreshToken,
      spaceID: state.defaultSpaceID,
    });
  }
  phaseRecap("Phase 5 done.");

  // Community asks — runs after the wow moment, when the user has
  // just experienced the value, so a Yes is meaningful.
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
 * One-off welcome preview rendered between the banner and Phase 1.
 * Suppressed under --quiet (the caller gates the call). Direct stdout
 * writes are fine here — this is a static block, not a step body, so
 * it doesn't need narrate/runSteps semantics.
 */
function writeWelcomePreview(): void {
  process.stdout.write("\n");
  process.stdout.write("  Welcome — here's the path ahead:\n");
  process.stdout.write("    1) Preflight            — check Docker is reachable\n");
  process.stdout.write("    2) Connect a model      — pick OpenRouter / Ollama / Custom\n");
  process.stdout.write("    3) Bring up your stack  — pull images, start services\n");
  process.stdout.write("    4) Wire your AI agents  — Claude Code / Cursor / Codex\n");
  process.stdout.write("    5) Prove it works       — write a memory, recall it back\n");
  process.stdout.write("\n");
}

/**
 * Drive Phase 2's provider menu + the matching setup branch. Returns
 * a fully-formed `ProviderResult`. Lives outside `runSteps` because
 * every branch issues interactive prompts that drive their own
 * readline cycle; the spinner-style step UI would conflict with line
 * input.
 *
 * The Ollama branch may return a `fallback` sentinel, in which case
 * we re-enter the OpenRouter setup automatically — the user already
 * told the inner prompt they want to fall back, so we don't ask again.
 */
async function runProviderPhase(): Promise<ProviderResult> {
  const kind = await selectProvider({
    promptFn: (o) => prompt({ message: o.message, default: o.default }),
    log: writeLine,
  });

  if (kind === "openrouter") {
    return { kind: "openrouter", config: await runOpenRouterSetup() };
  }

  if (kind === "ollama") {
    const result = await setupOllama({
      promptFn: (o) => prompt({ message: o.message, default: o.default }),
      log: writeLine,
      isRunning: isOllamaRunning,
      hasOllamaCli: hasOllamaCli,
      listModels: listInstalledModels,
      pullModel: pullOllamaModel,
      getEmbedDim: getEmbedDim,
      filterEmbed: filterToSupportedEmbed,
    });
    if (result.kind === "ollama") {
      return { kind: "ollama", config: result };
    }
    // Fallback — user opted into OpenRouter inside setupOllama.
    writeLine(`      · ${result.reason} Falling back to OpenRouter.`);
    return { kind: "openrouter", config: await runOpenRouterSetup() };
  }

  // kind === "custom"
  const config = await setupCustom({
    promptFn: (o) =>
      prompt({ message: o.message, default: o.default, mask: o.mask }),
    log: writeLine,
  });
  return { kind: "custom", config };
}

/**
 * Drive the OpenRouter provider setup. Prints a section header so
 * the user knows we've left the menu and entered the interactive
 * key + model loop. The actual prompt loop lives in `providerSetup.ts`.
 */
async function runOpenRouterSetup(): Promise<ProviderConfig> {
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
 * Build Phase 3's step array — compose generation, image pull, stack
 * start, engine wait, account provision, and bridge keychain configure.
 * All steps run inside `runSteps` so the user gets the standard
 * ▸/✓/✗ progress UI.
 */
function buildStackSteps(
  opts: InitOptions,
  state: {
    composeBin?: Awaited<ReturnType<typeof resolveComposeBin>>;
    signingKey: string;
    provider?: ProviderResult;
    userID?: string;
    agentID?: string;
    defaultSpaceID?: string;
    refreshToken?: string;
  },
  engineURL: string,
  composeFile: string,
  installID: string,
): Step[] {
  return [
    {
      title: "Generate compose file at ~/.klio/runtime/",
      run: async () => {
        narrate("Writing your local stack config to ~/.klio/runtime/.");
        const provider = state.provider;
        const kind = provider?.kind ?? "openrouter";
        writeComposeFile({
          imageTag: opts.imageTag,
          jwtSigningKey: state.signingKey,
          embeddingModel: prefixModel(kind, providerEmbedModel(provider)),
          extractionModel: prefixModel(kind, providerExtractModel(provider)),
        });
        // Minimum env needed for compose's variable interpolation.
        // user/agent IDs are filled in after provisioning (Phase 4).
        writeEnvFile(buildEnvVars(provider, state.signingKey, "", ""));
        return { kind: "ok", status: composeFile };
      },
    },
    {
      title: "Pull container images",
      run: async () => {
        narrate(
          "Klio's three images come from GitHub Container Registry — engine, bridge, trust-app.",
        );
        return composePull(state.composeBin!, {
          cwd: runtimeDir(),
          services: ["postgres", "redis", "engine", "bridge", "trust-app"],
        });
      },
    },
    {
      title: "Start services (postgres, redis, engine, bridge)",
      run: async () => {
        narrate(
          "Postgres + pgvector for memory storage, Redis for cross-agent realtime, the engine API, the bridge daemon.",
        );
        return composeUp(state.composeBin!, {
          cwd: runtimeDir(),
          services: ["postgres", "redis", "engine", "bridge"],
        });
      },
    },
    {
      title: `Wait for engine to be ready at ${engineURL}`,
      run: async () => {
        narrate("Waiting for the engine's /health endpoint to respond 200.");
        await waitForEngineHealth(engineURL);
        return { kind: "ok", status: engineURL };
      },
    },
    {
      title: "Set up your account",
      run: async () => {
        narrate(
          "Your refresh token is stored encrypted inside the bridge — never written to ~/.klio/runtime/.env.",
        );
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
        narrate(
          "Handing your credentials to the bridge daemon so it can authenticate to the engine on every call.",
        );
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

        // The bridge daemon reads the keychain at process start, so a
        // configure landing AFTER the daemon already started leaves
        // the in-memory token stale. Restart the container so the
        // daemon's next refresh loop picks up the freshly-written
        // creds. Without this, /v1/tokens/refresh 401s in a tight
        // loop until the user manually restarts the stack.
        await composeRestart(state.composeBin!, runtimeDir(), BRIDGE_CONTAINER);

        return { kind: "ok", status: "stored + bridge restarted" };
      },
    },
  ];
}

/**
 * Phase 4's tail steps — refresh env file with provisioned IDs, then
 * start the trust-app dashboard. The adapter detection + confirm step
 * runs separately (outside `runSteps`) because it needs an interactive
 * [Y/n] prompt.
 */
function buildPostWireSteps(
  state: {
    composeBin?: Awaited<ReturnType<typeof resolveComposeBin>>;
    signingKey: string;
    provider?: ProviderResult;
    userID?: string;
    agentID?: string;
  },
  envFile: string,
): Step[] {
  return [
    {
      title: "Refresh local-dev env file with your IDs",
      run: async () => {
        narrate(
          "Filling in user_id + agent_id so the dashboard auto-logs you in.",
        );
        writeEnvFile(
          buildEnvVars(
            state.provider,
            state.signingKey,
            state.userID ?? "",
            state.agentID ?? "",
          ),
        );
        return { kind: "ok", status: envFile };
      },
    },
    {
      title: "Start the dashboard (trust-app)",
      run: async () => {
        narrate(
          `The dashboard runs at ${TRUST_APP_URL} — your timeline of every memory, redaction, and audit event.`,
        );
        return composeUp(state.composeBin!, {
          cwd: runtimeDir(),
          services: ["trust-app"],
        });
      },
    },
  ];
}

/**
 * Detect installed agent adapters, print the list, and confirm before
 * patching their configs. Mutates `state` with results so the caller
 * can surface errors after `runSteps` finishes.
 */
async function runAdapterStep(state: {
  detectedAdapters: Adapter[];
  adaptersConfigured: string[];
  adaptersErrored: string[];
  adaptersSkipped: boolean;
}): Promise<void> {
  process.stdout.write("\n");
  process.stdout.write("▸ Detecting your AI tools…\n");
  narrate(
    "Klio supports Claude Code, Cursor, and Codex — we patch each one's config to add the MCP server.",
  );
  const detected = allAdapters().filter((a) => a.installed());
  state.detectedAdapters = detected;

  if (detected.length === 0) {
    writeLine("");
    writeLine(
      "    No MCP-capable agents found. Install Claude Code, Cursor, or",
    );
    writeLine(
      "    Codex and re-run `klio init` to wire them up.",
    );
    return;
  }

  const foundNames = detected.map((a) => a.name()).join(", ");
  const notFound = allAdapters().filter((a) => !a.installed());
  writeLine("");
  writeLine(`    Found:     ${foundNames}`);
  if (notFound.length > 0) {
    const skipNames = notFound.map((a) => a.name()).join(", ");
    writeLine(`    Not found: ${skipNames} (skipping)`);
  }
  writeLine("");

  const answer = await prompt({
    message: "Wire all detected tools?",
    default: "Y",
  });
  if (!isYes(answer)) {
    state.adaptersSkipped = true;
    writeLine("    Skipped — re-run `klio init` to wire them.");
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
    writeLine(
      `  ✓ ${state.adaptersConfigured.join(" + ")} connected`,
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
 * Build the env-var bag written to ~/.klio/runtime/.env. Always
 * emits the shared keys (`KLIO_OPENROUTER_API_KEY`,
 * `KLIO_CUSTOM_BASE_URL`, `KLIO_CUSTOM_API_KEY`, `KLIO_EMBEDDING_DIM`,
 * `KLIO_LOG_LEVEL`) so compose's variable-interpolation never fails
 * on a missing variable; the engine-side router consults the
 * relevant pair based on the model-name prefix.
 *
 * Provider variants:
 *   - openrouter: writes the key, leaves Custom blank.
 *   - ollama:     leaves all upstream keys blank — the engine reaches
 *                 ollama via host.docker.internal:11434, no auth.
 *   - custom:     writes Custom base URL + key, leaves OpenRouter blank.
 *
 * `KLIO_EMBEDDING_DIM` carries the dim the npm-side probe verified
 * against the user's chosen embedding model. The engine uses it to
 * pin the default Space's `embedding_dim` for non-registry models
 * (custom/<...>, escape-hatch openrouter/<...> the engine doesn't
 * know natively). Always emitted (blank when missing) so compose's
 * variable interpolation never fails.
 */
function buildEnvVars(
  provider: ProviderResult | undefined,
  signingKey: string,
  userID: string,
  agentID: string,
): Record<string, string> {
  const base: Record<string, string> = {
    KLIO_JWT_SIGNING_KEY: signingKey,
    KLIO_LOCAL_USER_ID: userID,
    KLIO_LOCAL_AGENT_ID: agentID,
    KLIO_LOG_LEVEL: "INFO",
    KLIO_OPENROUTER_API_KEY: "",
    KLIO_CUSTOM_BASE_URL: "",
    KLIO_CUSTOM_API_KEY: "",
    KLIO_EMBEDDING_DIM: "",
  };
  if (!provider) return base;
  if (provider.kind === "openrouter") {
    base.KLIO_OPENROUTER_API_KEY = provider.config.openrouterKey;
  } else if (provider.kind === "custom") {
    base.KLIO_CUSTOM_BASE_URL = provider.config.baseUrl;
    base.KLIO_CUSTOM_API_KEY = provider.config.apiKey;
  }
  // Every provider variant carries an embeddingDim from its probe;
  // thread it into the engine container so non-registry model names
  // (custom/<...>, escape-hatch openrouter/<...>) still pin a valid
  // dim onto the default Space.
  base.KLIO_EMBEDDING_DIM = String(provider.config.embeddingDim);
  // ollama branch: nothing else to inject — host-network access via
  // host.docker.internal is configured by the compose template.
  return base;
}

/**
 * Pull the embedding-model name out of whichever variant of
 * `ProviderResult` we got. The three variants share the field name
 * but differ enough in shape that a generic accessor would obscure
 * intent — branch on `kind` and let TypeScript narrow.
 */
function providerEmbedModel(p: ProviderResult | undefined): string | undefined {
  if (!p) return undefined;
  return p.config.embeddingModel;
}

/**
 * Symmetric to `providerEmbedModel`. Pulls the chat / extraction
 * model name out of any variant.
 */
function providerExtractModel(
  p: ProviderResult | undefined,
): string | undefined {
  if (!p) return undefined;
  return p.config.extractionModel;
}

/**
 * Translate a user-supplied bare model name into the prefixed routing
 * shape the engine expects in KLIO_EMBEDDING_MODEL / KLIO_EXTRACTION_MODEL
 * (e.g. "openrouter/openai/text-embedding-3-small",
 * "ollama/nomic-embed-text", "custom/llama-3.1-70b").
 *
 * The engine's direct-httpx dispatch reads the leading prefix to pick
 * an upstream provider. Without the prefix, dispatch raises with an
 * "unsupported model" error — there's no implicit fallback to a
 * native-vendor SDK (the LiteLLM dependency that previously provided
 * that fallback was removed in 0.3.0).
 *
 * Idempotent: returns the input unchanged if the prefix is already
 * present, so users who type "openrouter/openai/text-embedding-3-small"
 * by hand also work.
 */
function prefixModel(
  kind: ProviderKind,
  name: string | undefined,
): string | undefined {
  if (!name) return name;
  return name.startsWith(`${kind}/`) ? name : `${kind}/${name}`;
}

/**
 * `which ollama` test. We need a CLI presence check separate from the
 * daemon liveness check (`isOllamaRunning`) so we can give the user a
 * precise diagnostic — "install Ollama" vs "start the daemon" — instead
 * of lumping them together.
 *
 * Resolves true on exit code 0, false on any other exit or a spawn
 * error (e.g. ENOENT). Stdout/stderr are silenced to avoid polluting
 * the onboarding UI on systems without `which`.
 */
function hasOllamaCli(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn("which", ["ollama"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
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
