// Emit a proxied conversation to the engine so agents WITHOUT hook
// support still feed the evidence loop.
//
// Capture lives in bridge/internal/hooks today, which reaches only
// harnesses that support hooks — in practice Claude Code. Codex and any
// self-built agent write memories through MCP and are never retained,
// graded, or attributed. The proxy sees the whole conversation, so it is
// the one place their sessions can be captured.
//
// Strictly after the response is forwarded, strictly fire-and-forget.

import { createHash } from "node:crypto";

import type { CloudConfig } from "../cloudConfig.js";

/** Max UTF-8 bytes per individual block (tool_use input, tool_result content). */
const MAX_BLOCK_BYTES = 8000;

/** Max UTF-8 bytes for the entire serialized transcript payload (256 KB). */
const MAX_TRANSCRIPT_BYTES = 256 * 1024;

/**
 * Below this much leftover room, a partially admitted turn carries no
 * useful evidence and is not worth the marker it costs.
 */
const MIN_FRAGMENT_BYTES = 512;

/** One rendered turn of the transcript as it is sent. */
type Turn = { role: string; content: string };

/** What the elision marker has to say beyond the count of dropped turns. */
type MarkerNote = "none" | "head" | "newest";

/**
 * The role of a raw message. A message whose role is absent, null, or
 * BLANK is a user message — the same default the render path applies,
 * so the two can never disagree about whether a conversation has an
 * opening user turn.
 *
 * The blank case is not hypothetical bookkeeping: `String("")` matches
 * neither "user" nor "assistant", so `conversationSessionId` returned
 * null and the ENTIRE capture was silently skipped, while the render
 * path's `|| "user"` would have treated the very same message as a user
 * turn. An omitted role captured; an empty-string role captured nothing.
 *
 * A NON-OBJECT entry (a bare string in `messages`) still returns "" and
 * therefore still makes the conversation uncapturable — DELIBERATELY.
 * There is no content to render, and inventing a turn for it would put
 * fabricated evidence in front of a grader. Do not "fix" that.
 */
function roleOf(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const role = (message as Record<string, unknown>)["role"];
  if (role === undefined || role === null) return "user";
  const text = String(role).trim();
  return text === "" ? "user" : text;
}

/** The content of a raw message, safely. */
function contentOf(message: unknown): unknown {
  if (!message || typeof message !== "object") return "";
  return (message as Record<string, unknown>)["content"];
}

/** Serialize for hashing. Never throws; unserializable input falls back. */
function seedOf(message: unknown): string {
  try {
    return JSON.stringify(message) ?? "";
  } catch {
    return String(message);
  }
}

/**
 * Derive a session id from the conversation's FIRST user message AND
 * FIRST assistant message. This ensures:
 * - Two conversations that both open with "hi" but get different replies
 *   produce DIFFERENT session ids (no collision/clobbering).
 * - Every turn of one conversation shares the same id (stable across turns).
 * - Turn 1 (user-only, no assistant yet) is skipped entirely, since the
 *   content reappears verbatim in turn 2's history (Anthropic API is stateless).
 *
 * The seed is the RAW serialization of those two messages, never their
 * rendered form: rendering applies the per-block cap, so two conversations
 * whose opening assistant message is a large tool_use block differing only
 * past 8000 bytes — a file write or a heredoc, a common opener — would
 * otherwise hash identically and clobber each other.
 *
 * Returns null if there's no assistant message yet (turn 1).
 * The engine's richer-transcript-wins upsert then keeps the fullest version.
 */
export function conversationSessionId(agent: string, messages: unknown[]): string | null {
  const firstUser = messages.find((m) => roleOf(m) === "user");
  const firstAssistant = messages.find((m) => roleOf(m) === "assistant");

  // Skip capture entirely if there's no assistant turn yet (turn 1).
  if (firstUser === undefined || firstAssistant === undefined) return null;

  const seed = seedOf(firstUser) + "\n \n" + seedOf(firstAssistant);
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 16);
  return `klio-proxy:${agent}:${hash}`;
}

/** Marker appended to a turn whose own content had to be cut. */
const TURN_TRUNCATED_SUFFIX = "…[turn truncated]";

/** Marker appended to a single content block that had to be cut. */
const BLOCK_TRUNCATED_SUFFIX = "…[truncated]";

/** UTF-8 bytes a code point occupies as-is. */
function utf8Width(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  // A lone surrogate is re-encoded as U+FFFD, which is also 3 bytes.
  if (code < 0x10000) return 3;
  return 4;
}

/**
 * UTF-8 bytes a code point occupies once JSON.stringify has escaped it —
 * the only measure that agrees with what actually ships on the wire.
 * A lone surrogate costs 6 ASCII bytes (`\uXXXX`), not the 3 bytes Node
 * would spend replacing it with U+FFFD.
 */
function jsonWidth(code: number): number {
  if (code === 0x22 || code === 0x5c) return 2; // \" and \\
  if (code < 0x20) {
    // \b \t \n \f \r have two-character escapes; the rest go to \u00XX.
    return code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
  }
  if (code >= 0xd800 && code <= 0xdfff) return 6; // lone surrogate -> \uXXXX
  return utf8Width(code);
}

/**
 * Truncate to a budget by walking whole code points, so a surrogate pair
 * is never split. Returns the longest prefix whose measured width fits.
 */
function truncateByCodePoints(
  content: string,
  maxUnits: number,
  measure: (code: number) => number,
): string {
  if (maxUnits <= 0) return "";
  let used = 0;
  let end = 0;
  while (end < content.length) {
    const code = content.codePointAt(end) as number;
    const width = measure(code);
    if (used + width > maxUnits) break;
    used += width;
    end += code > 0xffff ? 2 : 1;
  }
  return content.slice(0, end);
}

/** Bytes a string costs inside a JSON document, excluding its quotes. */
function jsonBytesOf(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
}

/**
 * Truncate a turn's content to a budget expressed in JSON-escaped UTF-8
 * bytes, appending the truncation marker. The returned string is
 * guaranteed to serialize into at most `maxJsonBytes` bytes, and never
 * ends mid-surrogate-pair.
 */
function truncateTurnContent(content: string, maxJsonBytes: number): string {
  if (jsonBytesOf(content) <= maxJsonBytes) return content;
  const budget = maxJsonBytes - jsonBytesOf(TURN_TRUNCATED_SUFFIX);
  // No room for even the marker: emit nothing rather than spin or overflow.
  // (The previous loop had no lower bound and spun forever for tiny budgets.)
  if (budget <= 0) return "";
  return truncateByCodePoints(content, budget, jsonWidth) + TURN_TRUNCATED_SUFFIX;
}

/** Truncate a rendered block to a raw UTF-8 byte budget, surrogate-safe. */
function truncateBlock(rendered: string): string {
  if (Buffer.byteLength(rendered, "utf8") <= MAX_BLOCK_BYTES) return rendered;
  const budget = MAX_BLOCK_BYTES - Buffer.byteLength(BLOCK_TRUNCATED_SUFFIX, "utf8");
  if (budget <= 0) return "";
  return truncateByCodePoints(rendered, budget, utf8Width) + BLOCK_TRUNCATED_SUFFIX;
}

/** Render Anthropic content (string or block array) to plain text. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => renderBlock(b))
    .filter((t): t is string => t !== "")
    .join("\n");
}

/** Render a single content block to text. Exported for unit testing. */
export function renderBlock(block: unknown): string {
  if (!block || typeof block !== "object") return "";
  const b = block as Record<string, unknown>;
  const type = b["type"];

  if (type === "text") {
    const text = b["text"];
    return typeof text === "string" ? text : "";
  }

  if (type === "tool_use") {
    const name = b["name"];
    const input = b["input"];
    try {
      const inputStr = JSON.stringify(input);
      return `[tool_use: ${name}] ${truncateBlock(inputStr)}`;
    } catch {
      // Circular or unserializable input; render safely.
      return `[tool_use: ${name}] [unserializable input]`;
    }
  }

  if (type === "tool_result") {
    const contentValue = b["content"];
    let rendered = "";
    if (typeof contentValue === "string") {
      rendered = contentValue;
    } else if (Array.isArray(contentValue)) {
      rendered = contentValue.map((c) => renderBlock(c)).filter((t): t is string => t !== "").join("\n");
    }
    return `[tool_result] ${truncateBlock(rendered)}`;
  }

  // Unknown block types are skipped.
  return "";
}

export type EmitCaptureOptions = {
  config: CloudConfig;
  agent: string;
  requestBody: Buffer;
  assistantText: string;
  fetchImpl?: typeof fetch;
};

export async function emitCapture(opts: EmitCaptureOptions): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    if (!opts.config.apiKey) return;

    const parsed = JSON.parse(opts.requestBody.toString("utf8")) as Record<string, unknown>;
    const rawMessages = Array.isArray(parsed["messages"]) ? (parsed["messages"] as unknown[]) : [];
    if (rawMessages.length === 0) return;

    // Derive session ID from UNTRUNCATED messages (before any truncation).
    // This ensures the ID stays stable across turns and prevents collisions.
    const sessionId = conversationSessionId(opts.agent, rawMessages);
    // Skip capture entirely if there's no assistant turn yet.
    if (sessionId === null) return;

    // Render all messages. `roleOf` is the same defaulting the session
    // id uses — no `|| "user"` fallback here, because that fallback WAS
    // the divergence: it quietly accepted roles the id path rejected,
    // hiding the fact that those conversations were never captured at
    // all. One function, one answer.
    const messages = rawMessages.map((m) => ({
      role: roleOf(m),
      content: textOf(contentOf(m)),
    }));
    if (opts.assistantText.trim() !== "") {
      messages.push({ role: "assistant", content: opts.assistantText });
    }

    // Truncate at turn granularity to fit within the payload cap. Every
    // measurement below accounts for the fully serialized payload — the
    // envelope and the elision marker included — so the thing measured is
    // always the thing sent.
    //
    // Sizing is arithmetic, not re-serialization: each turn is serialized
    // ONCE and its byte size cached. Re-stringifying the growing window on
    // every candidate made this quadratic, and it runs synchronously in the
    // response's "finish" handler, where it stalls every other in-flight
    // proxied request.
    const buildPayload = (msgs: Turn[]): string =>
      JSON.stringify({
        session_id: sessionId,
        messages: msgs,
        tool_calls: [] as unknown[],
      });

    const turnBytes = (turn: Turn): number =>
      Buffer.byteLength(JSON.stringify(turn), "utf8");

    // `JSON.stringify` of the whole payload costs the empty envelope, plus
    // each turn's own bytes, plus one comma between adjacent turns.
    const envelopeBytes = Buffer.byteLength(buildPayload([]), "utf8");
    const sizeOf = (sumOfTurns: number, count: number): number =>
      count === 0 ? envelopeBytes : envelopeBytes + sumOfTurns + count - 1;

    const sizes = messages.map(turnBytes);
    // suffixSum[i] = bytes of messages[i..end)
    const suffixSum = new Array<number>(messages.length + 1).fill(0);
    for (let i = messages.length - 1; i >= 0; i--) {
      suffixSum[i] = suffixSum[i + 1] + sizes[i];
    }

    const markerTurn = (dropped: number, note: MarkerNote): Turn | null => {
      if (dropped <= 0 && note === "none") return null;
      const elided = `${dropped} ${dropped === 1 ? "turn" : "turns"} elided`;
      if (note === "none") return { role: "system", content: `[${elided}]` };
      const detail =
        note === "head" ? "oldest kept turn truncated" : "newest turn truncated";
      return {
        role: "system",
        content: dropped > 0 ? `[${elided}, ${detail}]` : `[${detail}]`,
      };
    };

    const assemble = (marker: Turn | null, head: Turn | null, window: Turn[]): Turn[] => [
      ...(marker ? [marker] : []),
      ...(head ? [head] : []),
      ...window,
    ];

    /**
     * Last resort for a single turn that cannot fit whole: keep the turn,
     * cut its content to exactly the room left once the marker and the
     * envelope are accounted for.
     */
    const buildSingleOversized = (turn: Turn, dropped: number): string => {
      const marker = markerTurn(dropped, "newest");
      const skeleton: Turn = { role: turn.role, content: "" };
      const used = sizeOf(
        turnBytes(skeleton) + (marker ? turnBytes(marker) : 0),
        marker ? 2 : 1,
      );
      const content = truncateTurnContent(turn.content, MAX_TRANSCRIPT_BYTES - used);
      return buildPayload(assemble(marker, null, [{ role: turn.role, content }]));
    };

    let finalPayload: string;

    if (sizeOf(suffixSum[0], messages.length) <= MAX_TRANSCRIPT_BYTES) {
      finalPayload = buildPayload(messages);
    } else {
      // Admit whole turns newest-first while the complete payload still fits.
      let start = messages.length;
      while (start > 0) {
        const candidate = start - 1;
        const marker = markerTurn(candidate, "none");
        const sum = suffixSum[candidate] + (marker ? turnBytes(marker) : 0);
        const count = messages.length - candidate + (marker ? 1 : 0);
        if (sizeOf(sum, count) > MAX_TRANSCRIPT_BYTES) break;
        start = candidate;
      }

      if (start >= messages.length) {
        // Not even the newest turn fits whole. Keep it, truncated. The
        // "no half-present turns" rule does not apply here: there is no
        // partner turn to separate it from, and dropping it would ship a
        // transcript with no conversation in it at all.
        finalPayload = buildSingleOversized(
          messages[messages.length - 1],
          messages.length - 1,
        );
      } else {
        let window = messages.slice(start);
        let dropped = start;
        let head: Turn | null = null;

        // The turn that did not fit is usually where all the work is — a
        // long answer, or the ~33 capped tool results that alone exceed the
        // cap. Stopping at it and leaving the rest of the budget unused
        // ships a transcript with no evidence in it. Admit it TRUNCATED
        // into whatever room is left instead.
        if (start > 0) {
          const candidate = messages[start - 1];
          const marker = markerTurn(start - 1, "head");
          const skeleton: Turn = { role: candidate.role, content: "" };
          const used = sizeOf(
            suffixSum[start] + turnBytes(skeleton) + (marker ? turnBytes(marker) : 0),
            window.length + 1 + (marker ? 1 : 0),
          );
          const room = MAX_TRANSCRIPT_BYTES - used;
          if (room >= MIN_FRAGMENT_BYTES) {
            const content = truncateTurnContent(candidate.content, room);
            if (content !== "") {
              head = { role: candidate.role, content };
              dropped = start - 1; // it was truncated, not dropped
            }
          }
        }

        // No half-present turns: an assistant answer must not survive as a
        // WHOLE turn without the user prompt it answers. A truncated head
        // is exempt — it is announced as a fragment by the marker, and
        // dropping it is exactly the evidence loss above. Never empty the
        // transcript to satisfy the rule.
        if (head === null) {
          while (window.length > 1 && window[0].role === "assistant") {
            window = window.slice(1);
            dropped += 1;
          }
        }

        // Terminal check: measure what will actually be sent, and keep
        // dropping the oldest whole turn until it fits.
        const note: MarkerNote = head ? "head" : "none";
        finalPayload = buildPayload(assemble(markerTurn(dropped, note), head, window));
        while (
          Buffer.byteLength(finalPayload, "utf8") > MAX_TRANSCRIPT_BYTES &&
          window.length > 1
        ) {
          window = window.slice(1);
          dropped += 1;
          finalPayload = buildPayload(assemble(markerTurn(dropped, note), head, window));
        }

        // Still over: fall back to a single truncated turn, which always fits.
        if (Buffer.byteLength(finalPayload, "utf8") > MAX_TRANSCRIPT_BYTES) {
          finalPayload = buildSingleOversized(head ?? window[0], dropped);
        }
      }
    }

    await doFetch(`${opts.config.baseUrl}/capture/transcript`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vex-Key": opts.config.apiKey,
        "X-Vex-Agent": opts.config.agentId,
      },
      body: finalPayload,
    });
  } catch {
    // Best-effort by contract. A capture failure must never surface to
    // the agent, whose response has already been delivered.
  }
}
