// Interactive OpenRouter provider setup.
//
// Four-step flow:
//   1. API key → probe → re-prompt on failure.
//   2. Fetch the model catalog once (best-effort; survive failures).
//   3. Pick embedding model — numbered picker over the curated list,
//      falling back to free-form text input when the catalog is
//      unavailable. The picker also accepts any typed model id as an
//      escape hatch so users aren't boxed into our curation.
//   4. Pick chat model — same picker, separate curated list.
//
// Each pick step is followed by its corresponding live probe; on
// probe failure we log the error verbatim and re-prompt. The shape of
// the resolved config feeds directly into `~/.klio/runtime/.env`
// rendering during `klio init`.
//
// All five side-effect boundaries (`promptFn`, the three probes,
// `fetchCatalog`, and `log`) are injected via `SetupDeps`. The
// runtime caller in `init.ts` will wire the real implementations from
// `./prompt.js` and `./openrouter.js` here, but the orchestrator
// itself imports neither — the dependency-injection seam keeps the
// test suite hermetic and free of any network or stdin coupling.

import {
  type CatalogEntry,
  curateChatModels,
  curateEmbeddingModels,
  fetchModelCatalog as defaultFetchCatalog,
  knownEmbedDim,
} from "./openrouter.js";

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
  /**
   * Optional catalog fetcher injection. Defaults to the live
   * `fetchModelCatalog`. Tests override this to return curated
   * fixtures without a network round-trip. If the function rejects
   * (e.g. OpenRouter `/models` is down), the orchestrator silently
   * falls back to the free-form text-input flow with the same
   * defaults the 0.2.x release used.
   */
  fetchCatalog?: (key: string) => Promise<CatalogEntry[]>;
  /** Single-line console writer (typically wraps `console.log`). */
  log: (line: string) => void;
};

const DEFAULT_EMBED = "openai/text-embedding-3-small";
const DEFAULT_CHAT = "anthropic/claude-3-5-haiku";

type PickerOption = {
  /** Model id sent to OpenRouter (e.g. "openai/text-embedding-3-small"). */
  id: string;
  /** Display label — usually the same as id; kept separate for future i18n. */
  label: string;
  /** Brief tradeoff note rendered after the label (e.g. "$0.02/1M · 1536 dim"). */
  description: string;
};

/**
 * Drive the four-step interactive setup. Returns once every probe
 * has succeeded; never throws on a probe failure (the loop swallows
 * the error, logs it, and re-prompts).
 */
export async function setupProvider(deps: SetupDeps): Promise<ProviderConfig> {
  const { key, creditLine } = await collectKey(deps);
  if (creditLine) deps.log(creditLine);

  const catalog = await fetchCatalogSafe(deps, key);
  const embeddingOptions = catalog ? curateEmbeddingModels(catalog) : [];
  const chatOptions = catalog ? curateChatModels(catalog) : [];

  const { model: embeddingModel, result: embedRes } = await collectEmbedding(
    deps,
    key,
    embeddingOptions,
  );
  const { model: extractionModel, result: chatRes } = await collectChat(
    deps,
    key,
    chatOptions,
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

/**
 * Best-effort catalog fetch. Returns `null` instead of throwing when
 * the call fails so the picker can quietly degrade to the free-form
 * text flow. The caller decides what to render in the degraded case;
 * this helper just emits a one-line note so the user knows why the
 * picker isn't available.
 */
async function fetchCatalogSafe(
  deps: SetupDeps,
  key: string,
): Promise<CatalogEntry[] | null> {
  const fetchFn = deps.fetchCatalog ?? defaultFetchCatalog;
  try {
    return await fetchFn(key);
  } catch (err) {
    deps.log(
      `      · Catalog unavailable (${(err as Error).message}); using defaults.`,
    );
    return null;
  }
}

/**
 * Collect the embedding model. Uses the curated picker when the
 * catalog has any usable entries; otherwise falls back to the
 * free-form prompt with the historical default.
 */
async function collectEmbedding(
  deps: SetupDeps,
  key: string,
  catalogOptions: CatalogEntry[],
): Promise<{ model: string; result: { dim: number; tokensUsed: number } }> {
  const options = catalogOptions.map(toEmbeddingPickerOption);
  while (true) {
    const model = await pickModelOrFallback(
      deps,
      "Embedding model",
      options,
      DEFAULT_EMBED,
    );
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

/**
 * Collect the chat model. Same shape as `collectEmbedding` — separate
 * function rather than a generic helper because the success-line
 * formatting and option formatter differ between the two.
 */
async function collectChat(
  deps: SetupDeps,
  key: string,
  catalogOptions: CatalogEntry[],
): Promise<{
  model: string;
  result: { tokensUsed: number; latencyMs: number };
}> {
  const options = catalogOptions.map(toChatPickerOption);
  while (true) {
    const model = await pickModelOrFallback(
      deps,
      "Extraction model",
      options,
      DEFAULT_CHAT,
    );
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

/**
 * If the picker has no usable options (empty catalog or fetch
 * failure), fall back to a free-form prompt with the historical
 * default. Otherwise render the numbered picker with the default
 * highlighted. The default option is whichever option matches
 * `defaultModel`, falling back to index 0 when no match.
 */
async function pickModelOrFallback(
  deps: SetupDeps,
  prompt: string,
  options: PickerOption[],
  defaultModel: string,
): Promise<string> {
  if (options.length === 0) {
    const answer = await deps.promptFn({
      message: prompt,
      default: defaultModel,
    });
    return answer.trim() === "" ? defaultModel : answer.trim();
  }
  const defaultIdx = Math.max(
    0,
    options.findIndex((o) => o.id === defaultModel),
  );
  return pickModel(deps, prompt, options, defaultIdx);
}

/**
 * Render a numbered picker, accepting:
 *   - empty input → default option's id
 *   - "1".."N"    → that option's id
 *   - any other   → returned verbatim as a custom model name
 *
 * Custom-name input is the escape hatch for users who want a model
 * we didn't curate; we don't validate it here because the next probe
 * call surfaces a precise error if the id isn't valid.
 */
async function pickModel(
  deps: { promptFn: SetupDeps["promptFn"]; log: SetupDeps["log"] },
  prompt: string,
  options: PickerOption[],
  defaultIdx: number,
): Promise<string> {
  for (let i = 0; i < options.length; i++) {
    const star = i === defaultIdx ? " · ★ default" : "";
    const label = options[i].label.padEnd(36);
    deps.log(`     ${i + 1}) ${label} ${options[i].description}${star}`);
  }
  deps.log(`     (or type any model name)`);

  const choice = await deps.promptFn({
    message: prompt,
    default: String(defaultIdx + 1),
  });
  const trimmed = choice.trim();
  if (trimmed === "") return options[defaultIdx].id;
  const n = Number(trimmed);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) {
    return options[n - 1].id;
  }
  return trimmed;
}

/**
 * Format an embedding-catalog entry for the picker. Pricing on
 * OpenRouter is reported per-token in USD as a string; we render it
 * as $/1M tokens for human readability and append the known dim.
 */
function toEmbeddingPickerOption(entry: CatalogEntry): PickerOption {
  const pricePerToken = Number(entry.pricing?.prompt ?? "0");
  const pricePerMillion = pricePerToken * 1_000_000;
  const dim = knownEmbedDim(entry.id);
  const dimSuffix = dim !== undefined ? ` · ${dim} dim` : "";
  return {
    id: entry.id,
    label: entry.id,
    description: `$${pricePerMillion.toFixed(2)}/1M${dimSuffix}`,
  };
}

/**
 * Format a chat-catalog entry. Includes both prompt and completion
 * pricing because chat usage is dominated by completion tokens for
 * the extraction workload.
 */
function toChatPickerOption(entry: CatalogEntry): PickerOption {
  const promptPerMillion = Number(entry.pricing?.prompt ?? "0") * 1_000_000;
  const completionPerMillion =
    Number(entry.pricing?.completion ?? "0") * 1_000_000;
  return {
    id: entry.id,
    label: entry.id,
    description: `$${promptPerMillion.toFixed(2)}/$${completionPerMillion.toFixed(2)} per 1M`,
  };
}
