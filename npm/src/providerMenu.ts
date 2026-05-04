// Provider menu — render the three-option model-provider list and
// return the user's pick.
//
// This module is the front door of the immersive onboarding flow: it
// runs after the Docker preflight and before any provider-specific
// setup, so the user picks their lane (OpenRouter / Ollama / Custom)
// before we collect API keys, ping endpoints, or write `.env` files.
//
// Like `providerSetup.ts`, both side-effect boundaries (`promptFn`
// and `log`) are injected via `MenuDeps`. The runtime caller in
// `init.ts` will wire the real `prompt` module from `./prompt.js`
// here, but this orchestrator imports neither — the dependency-
// injection seam keeps the test suite hermetic and free of any
// readline or stdin coupling.

/**
 * The three model-provider paths Klio supports out of the box.
 *
 * - openrouter: OpenRouter as the LLM gateway. One API key, hundreds
 *   of models, attribution headers attached. The default for the
 *   onboarding flow because it's the lowest-friction cloud option.
 *
 * - ollama: A local Ollama daemon. Detection + model listing + pull
 *   driven by `ollama.ts`. The privacy-purist path: text never
 *   crosses the network.
 *
 * - custom: A user-supplied OpenAI-compatible endpoint (self-hosted
 *   LiteLLM proxy, Azure OpenAI, vLLM, Together, Groq, etc.). Same
 *   wire shape as OpenRouter; the user provides base URL + API key.
 */
export type ProviderKind = "openrouter" | "ollama" | "custom";

export type MenuDeps = {
  /**
   * Issue an interactive prompt and resolve to the user's response.
   * In production this wraps `./prompt.ts`; in tests this is a stub.
   */
  promptFn: (opts: { message: string; default?: string }) => Promise<string>;
  /** Single-line console writer (typically wraps `console.log`). */
  log: (line: string) => void;
};

/**
 * Render the three-option provider menu and return the user's pick.
 *
 * Re-prompts on any input that isn't `""`/`"1"`/`"2"`/`"3"` (after
 * trim). The error line is logged via `deps.log` so a quiet-mode
 * caller can route it to stderr or suppress entirely.
 */
export async function selectProvider(deps: MenuDeps): Promise<ProviderKind> {
  deps.log("");
  deps.log("  Pick your model provider:");
  deps.log("    1) OpenRouter   one API key, hundreds of models — recommended");
  deps.log("    2) Ollama       fully local, your text never leaves the machine");
  deps.log("    3) Custom       bring your own OpenAI-compatible endpoint");
  deps.log("                    (LiteLLM proxy, Azure, vLLM, etc.)");
  deps.log("");

  while (true) {
    const choice = await deps.promptFn({ message: "Choice", default: "1" });
    const trimmed = choice.trim();
    if (trimmed === "" || trimmed === "1") return "openrouter";
    if (trimmed === "2") return "ollama";
    if (trimmed === "3") return "custom";
    deps.log(`      ✗ pick 1, 2, or 3 (got ${JSON.stringify(trimmed)})`);
  }
}
