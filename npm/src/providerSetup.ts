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
import type { OllamaModel } from "./ollama.js";

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

// ---------------------------------------------------------------------------
// Ollama provider setup
// ---------------------------------------------------------------------------
//
// Mirrors `setupProvider` in shape (deps-injected, side-effect free at
// the test layer) but the flow is materially different:
//
//   1. Detect the CLI binary. If absent → log install URL, offer a
//      friendly fallback to OpenRouter, and return the fallback
//      sentinel. If the user declines the fallback we throw to abort
//      `klio init` — the caller has no other path forward.
//   2. Detect the daemon. If the CLI is present but `/api/tags`
//      doesn't respond, same fallback dance.
//   3. List installed models. If no embedding-supported model is
//      installed, ask consent to pull a small default
//      (`nomic-embed-text`, ~274 MB). Stream progress to `log`.
//   4. Pick embedding model — numbered picker over the supported list.
//   5. Pick chat model — numbered picker over all installed models
//      (no dim filter for chat). If none are installed, ask consent
//      to pull a default (`llama3.1:8b`, ~4.7 GB) with a size warning.
//
// The sentinel-return pattern (rather than throwing) lets `init.ts`
// re-invoke `setupProvider` without stack unwinding through error
// machinery — it's a normal control-flow signal, not an exception.

/** Default embed model we offer to pull when none is installed. */
const DEFAULT_OLLAMA_EMBED = "nomic-embed-text";
/** Approximate on-disk size shown in the consent prompt. */
const DEFAULT_OLLAMA_EMBED_SIZE = "~274 MB";
/** Default chat model. */
const DEFAULT_OLLAMA_CHAT = "llama3.1:8b";
/** Approximate on-disk size shown in the consent prompt. */
const DEFAULT_OLLAMA_CHAT_SIZE = "~4.7 GB";

export type OllamaConfig = {
  kind: "ollama";
  /** Embedding model name as Ollama reports it (with tag). */
  embeddingModel: string;
  /** Static dim from the known-models map; never null on success. */
  embeddingDim: number;
  /** Chat / extraction model name (with tag). */
  extractionModel: string;
};

/**
 * Result type for `setupOllama`. The fallback variant carries a
 * human-readable reason so the caller can surface why the flow
 * pivoted before re-invoking `setupProvider`.
 */
export type OllamaSetupResult =
  | OllamaConfig
  | { kind: "fallback"; reason: string };

export type OllamaSetupDeps = {
  /** Same shape as the OpenRouter prompt — defaulted answer for [Y/n] flows. */
  promptFn: (opts: { message: string; default?: string }) => Promise<string>;
  /** Single-line console writer; receives every progress + status line. */
  log: (line: string) => void;
  /** Daemon liveness check. Wraps `isOllamaRunning` in production. */
  isRunning: () => Promise<boolean>;
  /**
   * CLI presence check (typically `which ollama`). We need this in
   * addition to `isRunning` so we can give the user a precise
   * diagnostic — "install Ollama" vs "start the daemon" — instead of
   * lumping them together.
   */
  hasOllamaCli: () => Promise<boolean>;
  /** Enumerate installed models. Wraps `listInstalledModels`. */
  listModels: () => Promise<OllamaModel[]>;
  /** `ollama pull <name>` driver with stderr forwarded to a callback. */
  pullModel: (
    name: string,
    onProgress: (line: string) => void,
  ) => Promise<void>;
  /** Static dim lookup for picked embedding model. Wraps `getEmbedDim`. */
  getEmbedDim: (name: string) => number | undefined;
  /** Filter to embedding-capable models. Wraps `filterToSupportedEmbed`. */
  filterEmbed: (models: OllamaModel[]) => OllamaModel[];
};

/**
 * Drive the Ollama-flavoured setup flow. Returns a fully-formed
 * `OllamaConfig` on success or a `fallback` sentinel when we want
 * the caller to redirect to OpenRouter. Throws only when the user
 * affirmatively declines both Ollama and the fallback — that's the
 * unrecoverable case `klio init` translates into a non-zero exit.
 */
export async function setupOllama(
  deps: OllamaSetupDeps,
): Promise<OllamaSetupResult> {
  // Step 1 + 2: CLI + daemon detection. Both produce the same kind
  // of fallback; only the user-facing message differs.
  const cliPresent = await deps.hasOllamaCli();
  if (!cliPresent) {
    return await offerFallback(
      deps,
      "Ollama CLI not found.",
      "      Install Ollama from https://ollama.com/download to use it as your provider.",
    );
  }
  const running = await deps.isRunning();
  if (!running) {
    return await offerFallback(
      deps,
      "Ollama daemon is not running.",
      "      Start the daemon with `ollama serve` (or launch the Ollama desktop app).",
    );
  }

  // Step 3: ensure an embedding model exists. If not, ask consent
  // and pull the small default. Decline → fallback (we can't proceed
  // without an embed model and we don't want to silently grow the
  // user's disk).
  let installed = await deps.listModels();
  let embedSupported = deps.filterEmbed(installed);
  if (embedSupported.length === 0) {
    const consent = await askYesNo(
      deps,
      `Pull \`${DEFAULT_OLLAMA_EMBED}\` (${DEFAULT_OLLAMA_EMBED_SIZE})?`,
      true,
    );
    if (!consent) {
      return {
        kind: "fallback",
        reason: "No Ollama embedding model installed and pull declined.",
      };
    }
    deps.log(`      · Pulling ${DEFAULT_OLLAMA_EMBED} …`);
    await deps.pullModel(DEFAULT_OLLAMA_EMBED, (line) =>
      deps.log(`      ${line}`),
    );
    // Refresh after the pull so the picker sees the new model.
    installed = await deps.listModels();
    embedSupported = deps.filterEmbed(installed);
  }

  const embeddingModel = await pickOllamaModel(
    deps,
    "Embedding model",
    embedSupported,
    DEFAULT_OLLAMA_EMBED,
  );
  const embeddingDim = deps.getEmbedDim(embeddingModel);
  if (embeddingDim === undefined) {
    // Picker accepted a custom name (escape hatch). Without a known
    // dim we can't write the runtime config, so fall back rather
    // than guess. This is a deliberately conservative choice —
    // letting the user override the dim could come in a later cut.
    return {
      kind: "fallback",
      reason: `Embedding dim unknown for ${embeddingModel}; pick a recognised model or use OpenRouter.`,
    };
  }

  // Step 5: chat model. No dim filter on the picker (any non-embed
  // model is fair game), but the empty-check is "no non-embed model
  // installed" — an embed-only install still triggers the consent +
  // pull dance because you can't run extraction off an embedder.
  let chatCandidates = nonEmbedModels(installed, embedSupported);
  if (chatCandidates.length === 0) {
    const consent = await askYesNo(
      deps,
      `Pull \`${DEFAULT_OLLAMA_CHAT}\` (${DEFAULT_OLLAMA_CHAT_SIZE} — large download)?`,
      true,
    );
    if (!consent) {
      return {
        kind: "fallback",
        reason: "No Ollama chat model installed and pull declined.",
      };
    }
    deps.log(`      · Pulling ${DEFAULT_OLLAMA_CHAT} …`);
    await deps.pullModel(DEFAULT_OLLAMA_CHAT, (line) =>
      deps.log(`      ${line}`),
    );
    installed = await deps.listModels();
    chatCandidates = nonEmbedModels(installed, deps.filterEmbed(installed));
  }

  const extractionModel = await pickOllamaModel(
    deps,
    "Extraction model",
    chatCandidates,
    DEFAULT_OLLAMA_CHAT,
  );

  return {
    kind: "ollama",
    embeddingModel,
    embeddingDim,
    extractionModel,
  };
}

/**
 * Render the install/start hint, then ask whether to use OpenRouter
 * for now. Y → fallback sentinel; N → throw to abort init. The
 * caller in `init.ts` translates the throw into a clean exit; we
 * don't catch it here because there's no further recovery path.
 */
async function offerFallback(
  deps: Pick<OllamaSetupDeps, "promptFn" | "log">,
  headline: string,
  hint: string,
): Promise<OllamaSetupResult> {
  deps.log(`      · ${headline}`);
  deps.log(hint);
  const useOpenRouter = await askYesNo(
    deps,
    "Use OpenRouter for now?",
    true,
  );
  if (useOpenRouter) {
    return { kind: "fallback", reason: headline };
  }
  throw new Error(
    `${headline} Cannot continue without a configured provider.`,
  );
}

/**
 * Yes/no prompt with a default answer. Returns true for affirmative
 * input or empty input when the default is yes; false otherwise.
 * Tolerates "Y", "yes", "n", "no", and any case combination.
 */
async function askYesNo(
  deps: Pick<OllamaSetupDeps, "promptFn">,
  message: string,
  defaultYes: boolean,
): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await deps.promptFn({
    message: `${message} ${suffix}`,
    default: defaultYes ? "Y" : "N",
  });
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "") return defaultYes;
  return trimmed === "y" || trimmed === "yes";
}

/**
 * Render a numbered picker for an Ollama model list. Mirrors
 * `pickModel` for OpenRouter but the option formatter is different
 * (sizes in MB/GB, no per-token pricing). Accepts the same three
 * kinds of input: empty → default, "1".."N" → that index, anything
 * else → returned verbatim as a custom name.
 *
 * If the default model isn't in the list, we still highlight one
 * (index 0) so the user always has a "press enter to accept" path.
 */
async function pickOllamaModel(
  deps: Pick<OllamaSetupDeps, "promptFn" | "log">,
  prompt: string,
  models: OllamaModel[],
  defaultBareName: string,
): Promise<string> {
  if (models.length === 0) {
    // Defensive — callers should pull before reaching this branch.
    // Surface the bare default so init.ts's free-form path still
    // gets something usable.
    return defaultBareName;
  }
  const defaultIdx = Math.max(
    0,
    models.findIndex((m) => bareName(m.name) === defaultBareName),
  );
  for (let i = 0; i < models.length; i++) {
    const star = i === defaultIdx ? " · ★ default" : "";
    const label = models[i].name.padEnd(36);
    deps.log(`     ${i + 1}) ${label} ${formatSize(models[i].size)}${star}`);
  }
  deps.log(`     (or type any model name)`);

  const choice = await deps.promptFn({
    message: prompt,
    default: String(defaultIdx + 1),
  });
  const trimmed = choice.trim();
  if (trimmed === "") return models[defaultIdx].name;
  const n = Number(trimmed);
  if (Number.isInteger(n) && n >= 1 && n <= models.length) {
    return models[n - 1].name;
  }
  return trimmed;
}

/** Strip the `:tag` suffix; mirror of the helper in `ollama.ts`. */
function bareName(name: string): string {
  const colon = name.indexOf(":");
  return colon >= 0 ? name.slice(0, colon) : name;
}

/**
 * Subtract the embed-supported subset from the full installed list.
 * Used to find chat-capable candidates: any installed model that
 * isn't a recognised embedding model is treated as a chat
 * candidate. Comparison is by full name (with tag) because two tags
 * of the same family are independent installs and we want the
 * picker to show both.
 */
function nonEmbedModels(
  all: OllamaModel[],
  embeds: OllamaModel[],
): OllamaModel[] {
  const embedNames = new Set(embeds.map((m) => m.name));
  return all.filter((m) => !embedNames.has(m.name));
}

/**
 * Render a byte count as a short human label. Picker UI only — no
 * exact-byte semantics (e.g. we round to one decimal in GB), and we
 * don't bother with TB because nothing on Ollama Hub gets that big.
 */
function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  }
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(0)} MB`;
  }
  if (bytes >= 1_000) {
    return `${(bytes / 1_000).toFixed(0)} KB`;
  }
  return `${bytes} B`;
}
