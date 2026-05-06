/**
 * Provider-selection + setup flow shared between `klio init` Phase 2
 * and `klio update provider`. Both call sites get the same behaviour:
 * render the three-option provider menu (OpenRouter / Ollama /
 * Custom), drive the matching setup helper from `providerSetup.ts`,
 * and return a fully-formed `ProviderResult` ready for env-vars
 * assembly.
 *
 * Extracted from `commands/init.ts` in v0.5.0 (Task E4) so the
 * recovery path `klio update provider` doesn't have to duplicate the
 * dependency-wiring (probe functions, Ollama daemon discovery, the
 * Ollama-fallback-to-OpenRouter handoff). Centralising the logic
 * guarantees both entry points pick up future hardening (new model
 * curators, additional probe diagnostics) for free.
 *
 * Pure orchestration: depends only on the menu + setup modules and
 * the provider-side probe functions. No global state, no module-level
 * mutation. Both call sites pass their own `log` sink so the shared
 * function does not assume process.stdout — init uses its `writeLine`
 * helper, update writes directly to its configured stdout.
 */

import { spawn } from "node:child_process";

import { selectProvider } from "../providerMenu.js";
import {
  setupProvider,
  setupOllama,
  setupCustom,
  type ProviderConfig,
  type OllamaConfig,
  type CustomConfig,
} from "../providerSetup.js";
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
import { prompt as defaultPrompt, type PromptOptions } from "../prompt.js";

/**
 * Tagged union threading the picked provider's config to whoever
 * called `runProviderStep`. The `kind` discriminator drives the env
 * write at the call site (different keys for openrouter vs ollama
 * vs custom). Each variant carries the shape produced by its own
 * setup helper:
 *
 *   - openrouter: validated API key + chosen embed/extract models.
 *   - ollama:     local-only; no key, just model names + dim.
 *   - custom:     user-supplied base URL + key + model names.
 */
export type ProviderResult =
  | { kind: "openrouter"; config: ProviderConfig }
  | { kind: "ollama"; config: OllamaConfig }
  | { kind: "custom"; config: CustomConfig };

/**
 * Inputs for `runProviderStep`. Production callers leave `promptFn`
 * and `log` undefined and accept the defaults; tests pass injected
 * sinks so the suite stays hermetic.
 */
export type ProviderStepOptions = {
  /**
   * Sink for each line of user-facing output. Defaults to
   * `process.stdout.write(line + "\n")`. Production callers pass
   * their own sinks (init's `writeLine`, update's stdout write) so
   * tests can drive the function with a captured array.
   */
  log?: (line: string) => void;
  /**
   * Interactive prompt function. Defaults to `prompt` from the
   * top-level prompt module. Test callers can override to drive the
   * picker without a live readline.
   */
  promptFn?: (opts: PromptOptions) => Promise<string>;
};

/**
 * Drive the provider menu + the matching setup branch. Returns a
 * fully-formed `ProviderResult`. Lives outside `runSteps` because
 * every branch issues interactive prompts that drive their own
 * readline cycle; the spinner-style step UI would conflict with line
 * input.
 *
 * The Ollama branch may return a `fallback` sentinel from
 * `setupOllama`, in which case we re-enter the OpenRouter setup
 * automatically — the user already told the inner prompt they want
 * to fall back, so we don't ask again.
 */
export async function runProviderStep(
  opts: ProviderStepOptions = {},
): Promise<ProviderResult> {
  const log = opts.log ?? defaultLog;
  const userPrompt = opts.promptFn ?? defaultPrompt;

  const kind = await selectProvider({
    promptFn: (o) => userPrompt({ message: o.message, default: o.default }),
    log,
  });

  if (kind === "openrouter") {
    return { kind: "openrouter", config: await runOpenRouterSetup(userPrompt, log) };
  }

  if (kind === "ollama") {
    const result = await setupOllama({
      promptFn: (o) => userPrompt({ message: o.message, default: o.default }),
      log,
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
    log(`      · ${result.reason} Falling back to OpenRouter.`);
    return { kind: "openrouter", config: await runOpenRouterSetup(userPrompt, log) };
  }

  // kind === "custom"
  const config = await setupCustom({
    promptFn: (o) =>
      userPrompt({ message: o.message, default: o.default, mask: o.mask }),
    log,
  });
  return { kind: "custom", config };
}

/**
 * Drive the OpenRouter provider setup. Prints a section header so
 * the user knows we've left the menu and entered the interactive
 * key + model loop. The actual prompt loop lives in `providerSetup.ts`.
 *
 * Header text is emitted via `log` (not direct stdout) so tests
 * capturing the output stream still see the framing.
 */
async function runOpenRouterSetup(
  userPrompt: (opts: PromptOptions) => Promise<string>,
  log: (line: string) => void,
): Promise<ProviderConfig> {
  log("");
  log("▸ Connect your LLM provider (OpenRouter)");
  log("    Klio uses OpenRouter to route embedding + extraction");
  log("    calls to the model of your choice. Get a key at");
  log("    https://openrouter.ai/keys");
  log("");
  return setupProvider({
    promptFn: (o) =>
      userPrompt({ message: o.message, default: o.default, mask: o.mask }),
    probeKey,
    probeEmbedding: probeEmbeddingModel,
    probeChat: probeChatModel,
    log,
  });
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

function defaultLog(line: string): void {
  process.stdout.write(line + "\n");
}
