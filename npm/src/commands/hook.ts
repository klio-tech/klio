// `klio hook <event>` — the thin passive-capture client for Klio Cloud.
//
// Claude Code (and compatible agents) invoke this on lifecycle events,
// piping the event JSON on stdin. In LOCAL mode the Go bridge handles
// these events against the local engine; in CLOUD mode there is no
// bridge, so this command forwards the high-signal events straight to
// the hosted brain's REST capture endpoints (src/cloud.ts +
// services/mcp-server/app/capture.py).
//
// Cloud v1 wires exactly three events (the high-signal, low-cost set):
//
//   SessionStart      → POST /capture/recall (empty query → recency),
//                       then print the memories as `additionalContext`
//                       so Claude Code injects them into the session.
//   UserPromptSubmit  → scan for explicit "remember that …" trigger
//                       phrases; on a match POST /capture/event as a
//                       durable `memory`. Plain prompts are NOT captured
//                       here (they're mined from the transcript at Stop)
//                       — this mirrors the local bridge and keeps noise
//                       and embedding cost down.
//   Stop              → read the session transcript file and POST
//                       /capture/transcript so the brain distils it into
//                       facts + a summary.
//
// Every other event is a clean no-op. The command is SOFT-FAIL by
// contract: a missing config, a malformed payload, or a network error
// all resolve to exit 0 with no output — a hook must never block or
// disrupt the user's session.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  CLOUD_CAPTURE_PATHS,
  VEX_AGENT_HEADER,
  VEX_KEY_HEADER,
  perToolAgentId,
} from "../cloud.js";
import { type CloudConfig, readCloudConfig } from "../cloudConfig.js";

/** Subset of the Claude Code hook stdin payload this client reads. */
type HookPayload = {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
};

/** A single transcript message in the shape the capture endpoint expects. */
type TranscriptMessage = { role: string; content: string };

/**
 * Injectable seams so the unit suite drives the flow hermetically — no
 * real network, filesystem, git, or stdin. Production leaves them unset
 * and the real implementations are used.
 */
export type HookDeps = {
  /** Cloud config; `undefined` means "load from disk", `null` means "absent". */
  config?: CloudConfig | null;
  /** Raw stdin JSON. Production reads it in the CLI and passes it here. */
  stdin?: string;
  /** Network seam. Defaults to the runtime `fetch`. */
  fetchFn?: typeof fetch;
  /** Single-line writer for hook stdout (the `additionalContext` JSON). */
  stdout?: (line: string) => void;
  /** Resolve a repo's git remote from a cwd; returns `null` for non-git dirs. */
  gitRemoteFn?: (cwd: string) => string | null;
  /** Parse a transcript file path into messages. */
  readTranscriptFn?: (path: string) => TranscriptMessage[];
};

/** Per-request timeout (ms). A hung brain must not stall a Claude Code event. */
const CAPTURE_TIMEOUT_MS = 8_000;

/** Cap on transcript messages forwarded (the server also tail-caps by chars). */
const MAX_TRANSCRIPT_MESSAGES = 400;

/**
 * Explicit "store this" trigger phrases, ported verbatim from the local
 * bridge (bridge/internal/hooks/handlers.go) so cloud + local capture the
 * same user intents. The capture group is the fact to remember.
 */
const TRIGGER_PATTERNS: RegExp[] = [
  /\bremember\s+(?:that\s+)?(.+?)\s*$/i,
  /\bdon['‘’]t\s+forget\s+(?:that\s+)?(.+?)\s*$/i,
  /\bfrom\s+now\s+on,?\s+(.+?)\s*$/i,
  /\bnote\s+that\s+(.+?)\s*$/i,
];

/**
 * Run one hook event. Always resolves to a process exit code (always 0 —
 * hooks must never block the user) and never throws.
 */
export async function runHook(event: string, deps: HookDeps = {}): Promise<number> {
  const config = deps.config !== undefined ? deps.config : readCloudConfig();
  // No cloud config → this machine is local-mode (or not onboarded). Stay
  // silent so a stray hook never errors on every event.
  if (!config) return 0;

  const payload = parsePayload(deps.stdin ?? "");
  const normalized = normalizeEvent(event, payload);
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const log = deps.stdout ?? ((line: string) => process.stdout.write(line));

  try {
    switch (normalized) {
      case "SessionStart":
        await handleSessionStart(config, payload, fetchFn, log, deps);
        return 0;
      case "UserPromptSubmit":
        await handleUserPrompt(config, payload, fetchFn, deps);
        return 0;
      case "Stop":
        await handleStop(config, payload, fetchFn, deps);
        return 0;
      default:
        // Unhandled event (PreToolUse, PostToolUse, …) → clean no-op.
        return 0;
    }
  } catch {
    // Soft-fail: any unexpected error degrades to a silent success so the
    // user's Claude Code session is never disrupted.
    return 0;
  }
}

/**
 * SessionStart: fetch recent/relevant memories and emit them as
 * `additionalContext`. Empty results print nothing (no empty banner).
 */
async function handleSessionStart(
  config: CloudConfig,
  payload: HookPayload,
  fetchFn: typeof fetch,
  log: (line: string) => void,
  deps: HookDeps,
): Promise<void> {
  const res = await postCapture(config, fetchFn, CLOUD_CAPTURE_PATHS.recall, {
    query: "",
    limit: 12,
    ...resolveProject(payload.cwd, deps),
  });
  if (!res) return;

  const memories = Array.isArray(res.memories) ? res.memories : [];
  if (memories.length === 0) return;

  log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: formatContext(memories),
      },
    }),
  );
}

/**
 * UserPromptSubmit: capture an explicit "remember that …" as a durable
 * `memory`. Non-trigger prompts are intentionally ignored (mined later
 * from the transcript), so this stays high-signal.
 */
async function handleUserPrompt(
  config: CloudConfig,
  payload: HookPayload,
  fetchFn: typeof fetch,
  deps: HookDeps,
): Promise<void> {
  const message = payload.prompt ?? "";
  if (!message) return;
  const fact = matchTriggerPhrase(message);
  if (!fact) return;

  await postCapture(config, fetchFn, CLOUD_CAPTURE_PATHS.event, {
    content: fact,
    memory_type: "memory",
    metadata: { source: "user-trigger-phrase", session_id: payload.session_id },
    session_id: payload.session_id,
    ...resolveProject(payload.cwd, deps),
  });
}

/**
 * Stop: forward the session transcript so the brain distils it into facts
 * + a summary. No transcript path or no messages → no-op.
 */
async function handleStop(
  config: CloudConfig,
  payload: HookPayload,
  fetchFn: typeof fetch,
  deps: HookDeps,
): Promise<void> {
  if (!payload.transcript_path) return;
  const reader = deps.readTranscriptFn ?? readTranscript;
  const messages = reader(payload.transcript_path).slice(0, MAX_TRANSCRIPT_MESSAGES);
  if (messages.length === 0) return;

  await postCapture(config, fetchFn, CLOUD_CAPTURE_PATHS.transcript, {
    messages,
    session_id: payload.session_id,
    ...resolveProject(payload.cwd, deps),
  });
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** Parse the stdin JSON payload; tolerant of empty/malformed input. */
function parsePayload(stdin: string): HookPayload {
  const raw = stdin.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as HookPayload;
    }
  } catch {
    /* malformed → empty payload (soft-fail) */
  }
  return {};
}

/**
 * Normalize the event token to one of SessionStart | UserPromptSubmit |
 * Stop. Accepts the Claude Code canonical names, the local bridge's
 * subcommand names (session-start, user-prompt, session-stop), and falls
 * back to the payload's `hook_event_name`. Anything else passes through
 * (and runHook treats it as a no-op).
 */
function normalizeEvent(arg: string, payload: HookPayload): string {
  const raw = (arg || payload.hook_event_name || "").trim();
  const key = raw.toLowerCase().replace(/[_-]/g, "");
  if (key === "sessionstart") return "SessionStart";
  if (key === "userpromptsubmit" || key === "userprompt") return "UserPromptSubmit";
  if (key === "stop" || key === "sessionstop") return "Stop";
  return raw;
}

/** Render recalled memories as the SessionStart context block (bridge parity). */
function formatContext(memories: unknown[]): string {
  let out = "## Klio context for this session\n\n";
  for (const m of memories) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    const kind = typeof rec.memory_type === "string" ? rec.memory_type : "memory";
    const content = typeof rec.content === "string" ? rec.content : "";
    out += `- [${kind}] ${content}\n`;
  }
  out += "\nUse the `recall` tool to query for more context.\n";
  return out;
}

/** Return the first trigger-phrase fact in `message`, or null if none. */
function matchTriggerPhrase(message: string): string | null {
  for (const re of TRIGGER_PATTERNS) {
    const m = re.exec(message);
    if (m && m[1]) {
      const fact = m[1].trim().replace(/\.+$/, "").trim();
      if (fact) return fact;
    }
  }
  return null;
}

/**
 * Derive best-effort project identity from a cwd: always the repo root
 * (the cwd), plus the git remote when the directory is a git repo. The
 * server uses these to file/recall memories per project.
 */
function resolveProject(
  cwd: string | undefined,
  deps: HookDeps,
): { repo_root?: string; git_remote?: string } {
  if (!cwd) return {};
  const out: { repo_root?: string; git_remote?: string } = { repo_root: cwd };
  const gitFn = deps.gitRemoteFn ?? defaultGitRemote;
  const remote = gitFn(cwd);
  if (remote) out.git_remote = remote;
  return out;
}

/** Resolve `origin`'s git remote URL for a cwd; null on any failure. */
function defaultGitRemote(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    const trimmed = out.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/**
 * Parse a Claude Code session JSONL transcript into {role, content}
 * messages. Permissive across format versions: handles a top-level
 * message or a nested `message` object, `content` as a string or as an
 * array of `{type:"text", text}` blocks, and keeps only user/assistant
 * turns (tool/system lines are dropped as noise). Unreadable file → [].
 */
function readTranscript(path: string): TranscriptMessage[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const out: TranscriptMessage[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;

    const rec = obj as Record<string, unknown>;
    const msg =
      rec.message && typeof rec.message === "object" && !Array.isArray(rec.message)
        ? (rec.message as Record<string, unknown>)
        : rec;

    let role = typeof msg.role === "string" ? msg.role : "";
    if (!role && typeof rec.type === "string") role = rec.type;
    if (role !== "user" && role !== "assistant") continue;

    const content = extractContent(msg);
    if (!content) continue;
    out.push({ role, content });
  }
  return out;
}

/** Pull message text from a transcript record (string | text | block array). */
function extractContent(rec: Record<string, unknown>): string {
  const c = rec.content;
  if (typeof c === "string") return c;
  if (typeof rec.text === "string") return rec.text;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const item of c) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const tx = (item as Record<string, unknown>).text;
        if (typeof tx === "string" && tx) parts.push(tx);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * POST a capture request, returning the parsed JSON body or `null` on any
 * failure (non-2xx, network error, timeout, unparseable body). Carries the
 * `X-Vex-Key` / `X-Vex-Agent` auth headers and a hard timeout.
 *
 * This client runs ONLY as Claude Code's passive lifecycle hook, so the
 * `X-Vex-Agent` header is tagged with the `claude-code` tool suffix
 * (`<machineId>/claude-code`) to mirror the per-tool attribution the MCP
 * wiring applies. `config.agentId` itself stays the bare machine id.
 */
async function postCapture(
  config: CloudConfig,
  fetchFn: typeof fetch,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const url = `${config.baseUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [VEX_KEY_HEADER]: config.apiKey,
        [VEX_AGENT_HEADER]: perToolAgentId(config.agentId, "claude-code"),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read all of stdin to a string. Resolves to "" for a TTY (no piped
 * payload) or on any read error, so the caller never hangs.
 */
export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}
