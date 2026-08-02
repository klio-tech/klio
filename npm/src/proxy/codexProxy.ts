// Point Codex at the local proxy, via ~/.codex/config.toml.
//
// Codex selects its API endpoint through a model provider:
//
//   model_provider = "klio-proxy"
//
//   [model_providers.klio-proxy]
//   name = "Klio proxy"
//   base_url = "http://localhost:8787/__klio/upstream/openai/v1"
//   wire_api = "responses"
//   env_key = "OPENAI_API_KEY"
//
// Note the base_url: it carries the proxy's OpenAI upstream prefix.
// Codex speaks OpenAI's wire protocol, not Anthropic's, so a bare
// http://localhost:8787 would send every Codex request to
// api.anthropic.com and 404. See proxy/src/klio_proxy/config.py.
//
// `env_key` names the variable Codex reads the API key from — the key
// never passes through Klio's config, and this file never holds a
// credential. That is deliberate: config.toml is mode 0644 by
// convention and users paste it into issue reports.
//
// The file is hand-edited (it also holds model defaults, sandbox
// policy, MCP servers), so it is NOT round-tripped through a TOML
// library — that would drop comments, blank lines and key ordering.
// We reuse the surgical line-scan editor in ../adapters/toml.ts,
// extended here with the same treatment for [model_providers.<name>].

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { backupFile } from "../adapters/fileutil.js";
import { PROXY_BASE_URL } from "./constants.js";
import {
  clearWiringTarget,
  readWiringState,
  updateWiringState,
  wiringStatePath,
  type PriorValue,
} from "./state.js";

/** Provider id written into config.toml. Namespaced to avoid collisions. */
export const CODEX_PROVIDER_ID = "klio-proxy";

/**
 * Codex's base URL. Includes the `/v1` suffix because Codex appends
 * only the endpoint path (`/responses`), matching how its built-in
 * `openai` provider is defined.
 */
export const CODEX_BASE_URL = `${PROXY_BASE_URL}/__klio/upstream/openai/v1`;

export function codexDir(): string {
  return join(homedir(), ".codex");
}

export function codexConfigPath(): string {
  return join(codexDir(), "config.toml");
}

/** Codex is installed when its config directory exists. */
export function codexInstalled(): boolean {
  return existsSync(codexDir());
}

export type CodexPaths = {
  configPath?: string;
  statePath?: string;
};

export type CodexProxyResult = {
  configPath: string;
  /** True when the file was written. */
  changed: boolean;
  /** Human-readable summary of what changed, for init's output. */
  summary: string;
  /**
   * The provider that was selected before, when it was not ours.
   * Surfaced so init can say plainly what it took over — and so the
   * user knows `klio uninit` is what gives it back.
   */
  replacedProvider?: string;
};

/**
 * Write the Klio provider block and select it.
 *
 * Idempotent — a second run produces a byte-identical file.
 *
 * An existing `model_provider` IS taken over, and the prior value is
 * recorded so `removeCodexProxy` gives it back exactly. The
 * alternative — refusing to change a selection the user already made —
 * was tried and rejected: Codex writes `model_provider = "openai"` for
 * most users, so declining would leave nearly everyone reporting
 * "Codex wired" while Codex still talked straight to OpenAI. A wiring
 * step that usually does not wire is worse than one that changes
 * something and says so.
 *
 * This mirrors the Claude Code path, which also overwrites
 * ANTHROPIC_BASE_URL and records what was there. Consistency matters
 * here: one agent that takes over and one that does not would make
 * `klio uninit`'s behaviour impossible to predict.
 */
export function applyCodexProxy(paths: CodexPaths = {}): CodexProxyResult {
  const path = paths.configPath ?? codexConfigPath();
  const statePath = paths.statePath ?? wiringStatePath();

  const prior = existsSync(path) ? readFileSync(path, "utf8") : "";
  const previousProvider = readModelProvider(prior);
  const hadOurBlock = findProviderRange(prior, CODEX_PROVIDER_ID) !== null;

  let next = upsertProviderBlock(prior, CODEX_PROVIDER_ID, {
    name: "Klio proxy",
    base_url: CODEX_BASE_URL,
    wire_api: "responses",
    env_key: "OPENAI_API_KEY",
  });

  const replaced =
    previousProvider !== null && previousProvider !== CODEX_PROVIDER_ID
      ? previousProvider
      : undefined;

  next = setModelProvider(next, CODEX_PROVIDER_ID);

  if (next === prior) {
    return { configPath: path, changed: false, summary: "already pointing at the Klio proxy" };
  }

  if (existsSync(path)) backupFile(path);
  writeFileSync(path, next, { mode: 0o644 });

  const existing = readWiringState(statePath).codex;
  updateWiringState(
    {
      codex: {
        configPath: path,
        // Preserve the ORIGINAL prior selection across re-runs, so
        // uninit restores what the user had before Klio, not what Klio
        // itself last wrote.
        previousModelProvider: existing?.previousModelProvider ?? previousProvider,
        createdProviderBlock: existing?.createdProviderBlock ?? !hadOurBlock,
        appliedAt: new Date().toISOString(),
      },
    },
    statePath,
  );

  return {
    configPath: path,
    changed: true,
    summary: `model_provider = "${CODEX_PROVIDER_ID}" → ${CODEX_BASE_URL}`,
    ...(replaced ? { replacedProvider: replaced } : {}),
  };
}

/**
 * Remove the Klio provider block and restore the prior selection.
 *
 * The block is only removed if we created it; a block a user has since
 * hand-edited is theirs. The selection is only reverted if it still
 * points at us.
 */
export function removeCodexProxy(paths: CodexPaths = {}): CodexProxyResult {
  const path = paths.configPath ?? codexConfigPath();
  const statePath = paths.statePath ?? wiringStatePath();

  if (!existsSync(path)) {
    clearWiringTarget("codex", statePath);
    return { configPath: path, changed: false, summary: "no Codex config to clean up" };
  }

  const prior = readFileSync(path, "utf8");
  const recorded = readWiringState(statePath).codex;
  let next = prior;

  if (readModelProvider(next) === CODEX_PROVIDER_ID) {
    const restore = recorded?.previousModelProvider ?? null;
    next = restore === null ? removeModelProvider(next) : setModelProvider(next, restore);
  }

  next = removeProviderBlock(next, CODEX_PROVIDER_ID);

  if (next === prior) {
    clearWiringTarget("codex", statePath);
    return { configPath: path, changed: false, summary: "nothing of Klio's to remove" };
  }

  backupFile(path);
  writeFileSync(path, next, { mode: 0o644 });
  clearWiringTarget("codex", statePath);

  return {
    configPath: path,
    changed: true,
    summary: recorded?.previousModelProvider
      ? `restored model_provider = "${recorded.previousModelProvider}"`
      : "removed the Klio provider and its selection",
  };
}

/** Non-mutating read of the current selection + our base_url, for doctor. */
export function readCodexProxy(path = codexConfigPath()): {
  selected: PriorValue;
  baseUrl: PriorValue;
} {
  if (!existsSync(path)) return { selected: null, baseUrl: null };
  const body = readFileSync(path, "utf8");
  return { selected: readModelProvider(body), baseUrl: readProviderBaseUrl(body) };
}

// ---- surgical TOML editing --------------------------------------------
//
// Same approach as ../adapters/toml.ts: locate the block by line scan
// and rewrite only that slice. Every other byte of the user's file is
// preserved, comments included.

function providerHeader(name: string): string {
  return `[model_providers.${name}]`;
}

/** Character range of `[model_providers.<name>]` and its sub-tables. */
function findProviderRange(
  body: string,
  name: string,
): { start: number; end: number } | null {
  const header = providerHeader(name);
  const subPrefix = `[model_providers.${name}.`;
  const lines = body.split("\n");

  const startLine = lines.findIndex((l) => l.trim() === header);
  if (startLine === -1) return null;

  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith("[")) continue;
    // A sub-table of ours continues the block. `[model_providers.klio]`
    // vs `[model_providers.klio-other]` is distinguished by requiring
    // a literal "." after the name.
    if (t.startsWith(subPrefix)) continue;
    endLine = i;
    break;
  }

  return { start: lineOffset(lines, startLine), end: lineOffset(lines, endLine) };
}

function lineOffset(lines: string[], index: number): number {
  let offset = 0;
  for (let i = 0; i < index; i++) offset += lines[i].length + 1;
  if (index === lines.length && index > 0) offset -= 1;
  return offset;
}

function renderProvider(name: string, fields: Record<string, string>): string {
  const lines = [providerHeader(name)];
  for (const [k, v] of Object.entries(fields)) {
    // JSON.stringify handles quotes, backslashes and control characters
    // the same way TOML basic strings do, for the subset we emit.
    lines.push(`${k} = ${JSON.stringify(v)}`);
  }
  return lines.join("\n") + "\n";
}

function upsertProviderBlock(
  body: string,
  name: string,
  fields: Record<string, string>,
): string {
  const rendered = renderProvider(name, fields);
  const range = findProviderRange(body, name);
  if (range) return body.slice(0, range.start) + rendered + body.slice(range.end);
  if (body.length === 0) return rendered;
  // Exactly one blank line of separation, computed from the current
  // trailing whitespace so repeat runs cannot grow the gap.
  return body.replace(/\n*$/, "") + "\n\n" + rendered;
}

function removeProviderBlock(body: string, name: string): string {
  const range = findProviderRange(body, name);
  if (!range) return body;
  const stripped = body.slice(0, range.start) + body.slice(range.end);
  // Collapse the blank-line gap our own insertion introduced, so an
  // install/uninstall round trip is byte-neutral.
  return stripped.replace(/\n{3,}$/, "\n").replace(/^\n+/, "");
}

/**
 * Read the active `model_provider`. Only top-level assignments count —
 * a `model_provider` key inside a `[profiles.x]` table belongs to that
 * profile, not to the root config.
 */
function readModelProvider(body: string): PriorValue {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) break; // past the root table
    const m = line.match(/^model_provider\s*=\s*"([^"]*)"/);
    if (m) return m[1];
  }
  return null;
}

/** Our provider's `base_url`, or null when the block is absent. */
function readProviderBaseUrl(body: string): PriorValue {
  const range = findProviderRange(body, CODEX_PROVIDER_ID);
  if (!range) return null;
  for (const raw of body.slice(range.start, range.end).split("\n")) {
    const m = raw.trim().match(/^base_url\s*=\s*"([^"]*)"/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Set the root `model_provider`, replacing an existing assignment in
 * place or prepending one above the first table header.
 *
 * Prepending (rather than appending) matters: a key written after the
 * first `[table]` header would belong to that table, not to the root,
 * and Codex would silently ignore it.
 */
function setModelProvider(body: string, provider: string): string {
  const assignment = `model_provider = ${JSON.stringify(provider)}`;
  const lines = body.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("[")) break;
    if (/^model_provider\s*=/.test(line)) {
      if (lines[i] === assignment) return body;
      lines[i] = assignment;
      return lines.join("\n");
    }
  }

  if (body.trim() === "") return assignment + "\n";
  return assignment + "\n" + body;
}

/** Remove the root `model_provider` assignment, if present. */
function removeModelProvider(body: string): string {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("[")) break;
    if (/^model_provider\s*=/.test(line)) {
      lines.splice(i, 1);
      return lines.join("\n");
    }
  }
  return body;
}
