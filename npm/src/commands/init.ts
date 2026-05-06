// `klio init` — the immersive 6-phase onboarding flow.
//
// Phases (left-to-right is strict; each phase depends on the
// artifacts of the one before):
//
//   Phase 1 / 6  ·  Preflight
//     - Check Docker is installed and running.
//
//   Phase 2 / 6  ·  Connect a model
//     - Provider menu (OpenRouter / Ollama / Custom).
//     - Provider-specific setup loop (key + model picks + probes).
//     - The Ollama branch may fall back to OpenRouter on detection
//       failure; the fallback is a control-flow signal, not an error.
//
//   Phase 3 / 6  ·  Bring up your stack
//     - Generate ~/.klio/runtime/{docker-compose.yml, .env}.
//     - Pull container images.
//     - Start postgres + redis + engine + bridge.
//     - Wait for engine /health.
//     - Provision an account against the local engine (HTTP).
//     - Persist credentials inside the bridge container.
//
//   Phase 4 / 6  ·  Wire your AI agents
//     - Detect installed agents; explicit [Y/n] confirm.
//     - Patch Claude Code + Cursor + Codex configs (if confirmed).
//     - Refresh env file with the user/agent IDs (so trust-app's
//       auto-login works on first boot).
//     - Bring up the trust-app dashboard.
//
//   Phase 5 / 6  ·  Memory curator
//     - One yes/no prompt with sane defaults (enabled, hourly,
//       model inherits from extraction). The new phase slots in
//       BEFORE the wow moment so the very first observations the
//       user creates in Phase 6 are already eligible for curation.
//     - Persist KLIO_CURATOR_* env vars into ~/.klio/.env.
//
//   Phase 6 / 6  ·  Prove it works
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

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
import {
  exchangeRefreshToken,
  provision,
  waitForEngineHealth,
} from "../engine.js";
import { generateSigningKey, getOrCreateInstallId } from "../installId.js";
import { allAdapters, type Adapter } from "../adapters/types.js";
import { wireDetectedAgents } from "./wireAgents.js";
import { runProviderStep, type ProviderResult } from "./providerStep.js";
import { prompt } from "../prompt.js";
import { prefixModel, prefixEmbeddingModel } from "../modelRouting.js";
import { askConfirm } from "../confirm.js";
import { runWowMoment } from "../wow.js";
import { runCommunityAsks } from "../community.js";
import { openUrl } from "../openUrl.js";
import {
  curatorEnvLines,
  type CuratorConfig,
} from "../curatorConfig.js";

const ENGINE_URL = "http://127.0.0.1:8000";
const TRUST_APP_URL = "http://127.0.0.1:3000";
// `BRIDGE_CONTAINER` is the docker container_name set in the compose
// template, used for `docker exec`. `BRIDGE_SERVICE` is the YAML key
// under `services:` in the same template, used for `docker compose
// restart`. They differ by convention: container_name follows the
// `klio-<svc>` pattern (so all five containers sort together in
// `docker ps`), while service names are bare (`bridge`, `engine`).
// Mixing them up is what made `docker compose restart klio-bridge`
// fail with "no such service" in 0.3.1.
const BRIDGE_CONTAINER = "klio-bridge";
const BRIDGE_SERVICE = "bridge";
// Agent enum value defined in
// engine/src/klio_engine/models/agent.py — must match an
// existing variant. We register the npm-launched user as
// "klio-bridge" (same as the Go-side `klio init`) because the
// daemon container is what actually performs reads/writes; the
// npm package is just the orchestrator that put it there.
const PROVISION_AGENT_KIND = "klio-bridge";

/**
 * Phase 5 default — what `klio init` writes when the user hits
 * Enter at the curator prompt. Hourly cadence is the design
 * default, and an empty model string tells the engine to fall
 * back to whichever extraction model the user picked in Phase 2.
 *
 * Held as a const so a future flag (e.g. --curator-cadence) can
 * override the default without diverging from the prompt UI.
 */
const DEFAULT_CURATOR_CONFIG: CuratorConfig = {
  enabled: true,
  cadence: "hourly",
  model: "",
};

/**
 * Phase 5 disabled — what `klio init` writes when the user
 * answers "n" at the curator prompt. The cadence slug "disabled"
 * is the recognized off state; `klio update curator` reading this
 * later will surface "off" in its picker.
 */
const DISABLED_CURATOR_CONFIG: CuratorConfig = {
  enabled: false,
  cadence: "disabled",
  model: "",
};

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
 * Re-export `ProviderResult` from the shared provider-step module
 * so existing imports of `commands/init.js` (tests, future callers)
 * keep working after the v0.5.0 extraction. The canonical home is
 * `commands/providerStep.ts`; this re-export is a stable seam.
 */
export type { ProviderResult } from "./providerStep.js";

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
    /**
     * Refresh token currently held by the npm CLI. Note: refresh
     * tokens are one-time-use rotation tokens. The original token
     * returned by `/v1/users/provision` is exchanged immediately
     * (see "Persist credentials" step) for an access token + the
     * NEXT refresh token. We hand the next-refresh-token to the
     * bridge container; the npm CLI keeps the access token only.
     * Any later use of `state.refreshToken` would 401 because the
     * bridge will rotate it again on its first refresh loop.
     */
    refreshToken?: string;
    /**
     * JWT access token minted by the immediate-after-provision
     * exchange. Used by Phase 6's wow-moment HTTP calls
     * (`/v1/spaces/<id>/entries`, `/v1/spaces/<id>/recall`) which
     * `require_auth` on the engine side decodes as a JWT.
     */
    accessToken?: string;
    detectedAdapters: Adapter[];
    adaptersConfigured: string[];
    adaptersErrored: string[];
    adaptersSkipped: boolean;
    /**
     * Phase 5 / Memory curator. Set after the user answers the one
     * yes/no prompt. Read by the Phase 5 env-refresh step (it appends
     * the curator block to ~/.klio/.env via `curatorEnvLines`).
     * Defaults baked in so a user who hits Enter gets curator on +
     * hourly + extraction-model fallback — see DEFAULT_CURATOR_CONFIG.
     */
    curatorConfig: CuratorConfig;
  } = {
    signingKey: existingSigningKey(envFile) ?? generateSigningKey(),
    detectedAdapters: [],
    adaptersConfigured: [],
    adaptersErrored: [],
    adaptersSkipped: false,
    curatorConfig: { ...DEFAULT_CURATOR_CONFIG },
  };

  const installID = getOrCreateInstallId();

  // -----------------------------------------------------------------
  // Phase 1 / 6 · Preflight
  // -----------------------------------------------------------------
  phaseHeader(1, 6, "Preflight");
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
  // Phase 2 / 6 · Connect a model
  // -----------------------------------------------------------------
  phaseHeader(2, 6, "Connect a model");
  if (!opts.skipProvider) {
    state.provider = await runProviderPhase();
  }
  phaseRecap("Phase 2 done.");

  // -----------------------------------------------------------------
  // Phase 3 / 6 · Bring up your stack
  // -----------------------------------------------------------------
  phaseHeader(3, 6, "Bring up your stack");
  await runSteps(buildStackSteps(opts, state, engineURL, composeFile, installID));
  phaseRecap(
    "Phase 3 done — engine, bridge, postgres, redis all running.",
  );

  // -----------------------------------------------------------------
  // Phase 4 / 6 · Wire your AI agents
  // -----------------------------------------------------------------
  phaseHeader(4, 6, "Wire your AI agents");
  await runAdapterStep(state);
  await runSteps(buildPostWireSteps(state, envFile));
  for (const e of state.adaptersErrored) {
    process.stderr.write(`! ${e}\n`);
  }
  phaseRecap("Phase 4 done — your agents are now talking to Klio.");

  // -----------------------------------------------------------------
  // Phase 5 / 6 · Memory curator
  // -----------------------------------------------------------------
  // ONE yes/no prompt — defaults baked in (enabled, hourly,
  // extraction-model fallback). The cadence + model picker lives
  // behind `klio update curator`, called out in the intro copy so
  // a power-user knows where to find it.
  //
  // Slots in BEFORE the wow moment so the very first observation
  // the user creates in Phase 6 is already eligible for curation.
  phaseHeader(5, 6, "Memory curator");
  await runCuratorStep(state, envFile);
  phaseRecap("Phase 5 done.");

  // -----------------------------------------------------------------
  // Phase 6 / 6 · Prove it works
  // -----------------------------------------------------------------
  phaseHeader(6, 6, "Prove it works");
  if (!opts.skipWow && state.accessToken && state.defaultSpaceID) {
    await runWowStep({
      engineURL,
      accessToken: state.accessToken,
      spaceID: state.defaultSpaceID,
    });
  }
  phaseRecap("Phase 6 done.");

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
  process.stdout.write("    5) Memory curator       — turn observations into durable memories\n");
  process.stdout.write("    6) Prove it works       — write a memory, recall it back\n");
  process.stdout.write("\n");
}

/**
 * Drive Phase 2's provider menu + the matching setup branch. Returns
 * a fully-formed `ProviderResult`. Delegates to the shared
 * `runProviderStep` (also used by `klio update provider`) so future
 * hardening — new probe diagnostics, additional model curators —
 * lands in both entry points without duplication.
 */
async function runProviderPhase(): Promise<ProviderResult> {
  return runProviderStep({ log: writeLine });
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
    accessToken?: string;
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
          // Embedding goes through prefixEmbeddingModel — strips
          // Ollama-style `:tag` suffixes that the engine's embedding
          // registry can't resolve. The 0.4.1 production bug was
          // sending `ollama/nomic-embed-text:latest` here, which 500'd
          // every Phase 5 entries / recall call. See modelRouting.ts.
          embeddingModel: prefixEmbeddingModel(
            kind,
            providerEmbedModel(provider),
          ),
          // Extraction keeps tags — chat model identity DOES depend on
          // them (`qwen2.5:7b-instruct` vs `qwen2.5:1.5b`), and the
          // engine's chat dispatch passes them straight to Ollama.
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
          "Your refresh token is stored encrypted inside the bridge — never written to ~/.klio/.env.",
        );
        const r = await provision(engineURL, {
          agentKind: PROVISION_AGENT_KIND,
          installID,
          email: opts.email,
        });
        state.userID = r.user_id;
        state.agentID = r.agent_id;
        state.defaultSpaceID = r.default_space_id;

        // Refresh tokens are one-time-use. The bridge daemon will
        // rotate this on its first refresh loop, so we exchange it
        // here BEFORE handing it over — the CLI keeps the resulting
        // access token (for Phase 5's wow moment) and forwards the
        // post-rotation refresh token to the bridge. Without this
        // pre-rotation step, the wow moment would 401 because the
        // bridge would have already invalidated the original token.
        const exchanged = await exchangeRefreshToken(engineURL, r.api_key);
        state.accessToken = exchanged.access_token;
        state.refreshToken = exchanged.refresh_token;

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
        await composeRestart(state.composeBin!, runtimeDir(), BRIDGE_SERVICE);

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
    "Klio supports Claude Code, Claude Desktop (Chat + Cowork), Cursor, Codex, OpenCode, and OpenClaw — we patch each one's config to add the MCP server.",
  );

  // Snapshot the detected adapters BEFORE handing off to the shared
  // wire-agents helper so downstream Phase 4/5 steps that read
  // `state.detectedAdapters` (e.g. trust-app dashboard wording) keep
  // their input. The helper itself re-runs detection, but since
  // `installed()` is a pure host-fs check the two readings agree.
  state.detectedAdapters = allAdapters().filter((a) => a.installed());

  if (state.detectedAdapters.length === 0) {
    writeLine("");
    writeLine(
      "    No MCP-capable agents found. Install Claude Code, Cursor, or",
    );
    writeLine(
      "    Codex and re-run `klio init` to wire them up.",
    );
    return;
  }

  // Delegate the detection + confirm + install loop to the shared
  // helper so `klio update agents` runs the EXACT same flow. The
  // helper handles the "Found / Not found / Wire all detected
  // tools?" UI and per-adapter install with backups; init's
  // responsibility shrinks to translating the result back into
  // `state` for the downstream phases.
  const result = await wireDetectedAgents({
    bridgeContainer: BRIDGE_CONTAINER,
    env: {},
    log: writeLine,
  });

  if (result.skipped && result.configured.length === 0 && result.errored.length === 0) {
    // Two paths land here: detection was empty (already handled
    // above with init-specific copy), OR the user answered "no" at
    // the confirm. Init wants the second case to print the recovery
    // hint that update.ts can't (it'd be circular there).
    state.adaptersSkipped = true;
    writeLine("    Skipped — re-run `klio init` to wire them.");
    return;
  }

  state.adaptersConfigured.push(...result.configured);
  for (const e of result.errored) {
    state.adaptersErrored.push(`${e.name}: ${e.message}`);
  }
}

/**
 * Phase 5 — Memory curator. ONE yes/no prompt with sane defaults
 * baked in. Persists the chosen `CuratorConfig` into `state` and
 * appends the matching env block to ~/.klio/.env so the engine
 * picks it up on its next start.
 *
 * The full cadence + model picker lives behind
 * `klio update curator` — keeping init.ts a single prompt avoids
 * onboarding fatigue.
 *
 * Defaults: enabled, hourly, model inherits from extraction.
 *
 * Re-prompts on garbage input via `askConfirm` (the 0.4.2 hardening
 * that protects against the "user typed memory text at the prompt"
 * class of bug).
 */
async function runCuratorStep(
  state: { curatorConfig: CuratorConfig },
  envFile: string,
): Promise<void> {
  process.stdout.write("\n");
  narrate(
    "Klio's curator reads your observations every hour and turns durable facts into proper memories — so recall keeps working even when agents forget to save things explicitly.",
  );
  writeLine("");
  writeLine("    Defaults: every hour · uses your extraction model.");
  writeLine("    Run `klio update curator` to change.");
  writeLine("");

  const enable = await askConfirm(
    prompt,
    "Enable?",
    true,
    writeLine,
  );

  state.curatorConfig = enable
    ? { ...DEFAULT_CURATOR_CONFIG }
    : { ...DISABLED_CURATOR_CONFIG };

  // Append the curator env block to ~/.klio/.env. Phase 4's
  // env-refresh step already (over)wrote the file with the
  // provider + identity lines via `writeEnvFile`; here we
  // append-only so a re-run of init re-emits a single curator
  // block at the bottom (the previous block is overwritten by
  // Phase 4's full re-write at the start, so we can't accumulate
  // duplicates across runs).
  appendFileSyncSafe(envFile, curatorEnvLines(state.curatorConfig));

  writeLine(enable ? "    ✓ enabled" : "    ✓ skipped");
}

/**
 * Append text to an env file, creating the file with mode 0600 if
 * it doesn't yet exist. The file is written by `writeEnvFile`
 * earlier in the flow (Phase 3 + Phase 4), so under normal init
 * conditions it always exists when we get here — but the safety
 * net keeps the helper independent of upstream order so a
 * future repair flow can call Phase 5 in isolation.
 */
function appendFileSyncSafe(path: string, content: string): void {
  if (existsSync(path)) {
    appendFileSync(path, content, { mode: 0o600 });
  } else {
    writeFileSync(path, content, { mode: 0o600 });
  }
}

/**
 * Run the wow moment. Wraps the `prompt` module to satisfy the
 * `WowDeps.promptFn` shape (multiline input) and provides a thin
 * `waitEnter` helper that blocks until the user presses Enter.
 */
async function runWowStep(args: {
  engineURL: string;
  accessToken: string;
  spaceID: string;
}): Promise<void> {
  await runWowMoment({
    engineURL: args.engineURL,
    accessToken: args.accessToken,
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

// `isYes` was the v0.4.1 single-shot helper that collapsed any
// non-y answer into "no" (the wire-tools-skip bug). The wire-tools
// prompt now uses the re-prompting `askConfirm` from
// `../confirm.ts`. The community-step prompts in `community.ts`
// keep their own one-shot behaviour intentionally — they're
// post-completion satisfaction asks where re-prompting on "no
// thanks" would feel naggy.

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

// `prefixModel` and `prefixEmbeddingModel` now live in
// `../modelRouting.ts` so the routing-shape logic can be unit-tested
// independently of the orchestration in this file. Imports at the
// top of the file pull both helpers in.

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
