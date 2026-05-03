// Interactive OpenRouter provider setup.
//
// Three sequential prompts (API key, embedding model, chat model),
// each followed by its corresponding live probe against OpenRouter.
// On probe failure we log the error verbatim and re-prompt — the loop
// only exits when the probe succeeds. The shape of the resolved
// config feeds directly into `~/.klio/runtime/.env` rendering during
// `klio init`.
//
// All four side-effect boundaries (`promptFn`, the three probes, and
// `log`) are injected via `SetupDeps`. The runtime caller in
// `init.ts` will wire the real `prompt` module from `./prompt.js` and
// the real probes from `./openrouter.js` here, but the orchestrator
// itself imports neither — the dependency-injection seam keeps the
// test suite hermetic and free of any network or stdin coupling.

export type ProviderConfig = {
  /** Validated OpenRouter API key. Sensitive — masked at prompt time. */
  openrouterKey: string;
  /** Embedding model the user accepted (default: openai/text-embedding-3-small). */
  embeddingModel: string;
  /** Vector dimensionality reported by the embedding probe. */
  embeddingDim: number;
  /** Extraction (chat) model the user accepted (default: anthropic/claude-3-5-haiku). */
  extractionModel: string;
  /** Sum of embedding + chat probe tokens — surfaced as "test cost = N tokens". */
  totalTestTokens: number;
};

export type SetupDeps = {
  /**
   * Issue an interactive prompt and resolve to the user's response.
   * In production this wraps `./prompt.ts`; in tests this is a stub.
   */
  promptFn: (opts: {
    message: string;
    default?: string;
    mask?: boolean;
  }) => Promise<string>;
  /** Resolves with key metadata or rejects with a user-facing message. */
  probeKey: (
    key: string,
  ) => Promise<{ label: string; creditRemaining: number | null }>;
  /** Resolves with the embedding dim/tokens or rejects with a user-facing message. */
  probeEmbedding: (
    key: string,
    model: string,
  ) => Promise<{ dim: number; tokensUsed: number }>;
  /** Resolves with chat tokens/latency or rejects with a user-facing message. */
  probeChat: (
    key: string,
    model: string,
  ) => Promise<{ tokensUsed: number; latencyMs: number }>;
  /** Single-line console writer (typically wraps `console.log`). */
  log: (line: string) => void;
};

const DEFAULT_EMBED = "openai/text-embedding-3-small";
const DEFAULT_CHAT = "anthropic/claude-3-5-haiku";

/**
 * Drive the three-step interactive setup. Returns once every probe
 * has succeeded; never throws on a probe failure (the loop swallows
 * the error, logs it, and re-prompts).
 */
export async function setupProvider(deps: SetupDeps): Promise<ProviderConfig> {
  const { key, creditLine } = await collectKey(deps);
  if (creditLine) deps.log(creditLine);

  const { model: embeddingModel, result: embedRes } = await collectEmbedding(
    deps,
    key,
  );
  const { model: extractionModel, result: chatRes } = await collectChat(
    deps,
    key,
  );

  return {
    openrouterKey: key,
    embeddingModel,
    embeddingDim: embedRes.dim,
    extractionModel,
    totalTestTokens: embedRes.tokensUsed + chatRes.tokensUsed,
  };
}

/**
 * Prompt for the API key and probe it until it validates. The
 * success-path log line is built here (rather than at the call site)
 * so the credit summary shows up in the same `log` stream the
 * failure messages use.
 */
async function collectKey(
  deps: SetupDeps,
): Promise<{ key: string; creditLine: string | null }> {
  while (true) {
    const key = await deps.promptFn({
      message: "OpenRouter API key",
      mask: true,
    });
    try {
      const info = await deps.probeKey(key);
      const creditSuffix =
        info.creditRemaining !== null
          ? ` · $${info.creditRemaining.toFixed(2)} credit available`
          : "";
      return {
        key,
        creditLine: `      ✓ Valid · ${info.label}${creditSuffix}`,
      };
    } catch (err) {
      deps.log(`      ✗ ${(err as Error).message}`);
    }
  }
}

async function collectEmbedding(
  deps: SetupDeps,
  key: string,
): Promise<{ model: string; result: { dim: number; tokensUsed: number } }> {
  while (true) {
    const model = await deps.promptFn({
      message: "Embedding model",
      default: DEFAULT_EMBED,
    });
    try {
      const result = await deps.probeEmbedding(key, model);
      deps.log(
        `      ✓ ${result.dim}-dim, ${result.tokensUsed} test token(s)`,
      );
      return { model, result };
    } catch (err) {
      deps.log(`      ✗ ${(err as Error).message}`);
    }
  }
}

async function collectChat(
  deps: SetupDeps,
  key: string,
): Promise<{
  model: string;
  result: { tokensUsed: number; latencyMs: number };
}> {
  while (true) {
    const model = await deps.promptFn({
      message: "Extraction model",
      default: DEFAULT_CHAT,
    });
    try {
      const result = await deps.probeChat(key, model);
      deps.log(
        `      ✓ responded in ${result.latencyMs}ms, ${result.tokensUsed} test token(s)`,
      );
      return { model, result };
    } catch (err) {
      deps.log(`      ✗ ${(err as Error).message}`);
    }
  }
}
