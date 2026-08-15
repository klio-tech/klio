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
 * Derive a session id from the conversation's FIRST user message AND
 * FIRST assistant message. This ensures:
 * - Two conversations that both open with "hi" but get different replies
 *   produce DIFFERENT session ids (no collision/clobbering).
 * - Every turn of one conversation shares the same id (stable across turns).
 * - Turn 1 (user-only, no assistant yet) is skipped entirely, since the
 *   content reappears verbatim in turn 2's history (Anthropic API is stateless).
 *
 * Returns null if there's no assistant message yet (turn 1).
 * The engine's richer-transcript-wins upsert then keeps the fullest version.
 */
export function conversationSessionId(agent: string, messages: unknown[]): string | null {
  const firstUser = messages.find(
    (m) => (m as Record<string, unknown> | null)?.["role"] === "user",
  ) as Record<string, unknown> | undefined;
  const firstAssistant = messages.find(
    (m) => (m as Record<string, unknown> | null)?.["role"] === "assistant",
  ) as Record<string, unknown> | undefined;

  // Skip capture entirely if there's no assistant turn yet (turn 1).
  if (!firstUser || !firstAssistant) return null;

  const userText = textOf(firstUser["content"]);
  const assistantText = textOf(firstAssistant["content"]);
  const seed = userText + "\n \n" + assistantText;
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 16);
  return `klio-proxy:${agent}:${hash}`;
}

/** Marker appended to a turn whose own content had to be cut. */
const TURN_TRUNCATED_SUFFIX = "…[turn truncated]";

/** Marker appended to a single content block that had to be cut. */
const BLOCK_TRUNCATED_SUFFIX = "…[truncated]";

/** UTF-8 bytes a code point occupies as-is. */
function utf8Width(codePoint: string): number {
  return Buffer.byteLength(codePoint, "utf8");
}

/**
 * UTF-8 bytes a code point occupies once JSON.stringify has escaped it —
 * the only measure that agrees with what actually ships on the wire.
 * A lone surrogate costs 6 ASCII bytes (`\uXXXX`), not the 3 bytes Node
 * would spend replacing it with U+FFFD.
 */
function jsonWidth(codePoint: string): number {
  return Buffer.byteLength(JSON.stringify(codePoint), "utf8") - 2;
}

/**
 * Truncate to a budget by walking whole code points, so a surrogate pair
 * is never split. Returns the longest prefix whose measured width fits.
 */
function truncateByCodePoints(
  content: string,
  maxUnits: number,
  measure: (codePoint: string) => number,
): string {
  if (maxUnits <= 0) return "";
  const kept: string[] = [];
  let used = 0;
  for (const codePoint of content) {
    const width = measure(codePoint);
    if (used + width > maxUnits) break;
    used += width;
    kept.push(codePoint);
  }
  return kept.join("");
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

    // Render all messages.
    const messages = rawMessages.map((m) => {
      const r = m as Record<string, unknown>;
      return { role: String(r["role"] ?? "user"), content: textOf(r["content"]) };
    });
    if (opts.assistantText.trim() !== "") {
      messages.push({ role: "assistant", content: opts.assistantText });
    }

    // Truncate at turn granularity to fit within the payload cap. Every
    // measurement below is taken on the fully serialized payload — the
    // envelope and the elision marker included — so the thing measured is
    // always the thing sent.
    type Turn = { role: string; content: string };

    const buildPayload = (msgs: Turn[]): string =>
      JSON.stringify({
        session_id: sessionId,
        messages: msgs,
        tool_calls: [] as unknown[],
      });

    const payloadBytes = (msgs: Turn[]): number =>
      Buffer.byteLength(buildPayload(msgs), "utf8");

    const withMarker = (msgs: Turn[], dropped: number, truncated: boolean): Turn[] => {
      if (dropped <= 0 && !truncated) return msgs;
      const label = truncated
        ? dropped > 0
          ? `[${dropped} turns elided, newest turn truncated]`
          : "[newest turn truncated]"
        : `[${dropped} turns elided]`;
      return [{ role: "system", content: label }, ...msgs];
    };

    /**
     * Last resort for a single turn that cannot fit whole: keep the turn,
     * cut its content to exactly the room left once the marker and the
     * envelope are accounted for.
     */
    const buildSingleOversized = (turn: Turn, dropped: number): string => {
      const skeleton = withMarker([{ role: turn.role, content: "" }], dropped, true);
      const overhead = payloadBytes(skeleton);
      const content = truncateTurnContent(turn.content, MAX_TRANSCRIPT_BYTES - overhead);
      return buildPayload(withMarker([{ role: turn.role, content }], dropped, true));
    };

    let finalPayload = buildPayload(messages);

    if (Buffer.byteLength(finalPayload, "utf8") > MAX_TRANSCRIPT_BYTES) {
      // Accumulate newest-first while the payload still fits.
      let kept: Turn[] = [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const candidate = [messages[i], ...kept];
        if (payloadBytes(candidate) > MAX_TRANSCRIPT_BYTES) break;
        kept = candidate;
      }

      if (kept.length === 0) {
        // The newest turn alone blows the cap. Keep it, truncated. The
        // "no half-present turns" rule does not apply here: there is no
        // partner turn to separate it from, and dropping it would ship a
        // transcript with no conversation in it at all.
        finalPayload = buildSingleOversized(
          messages[messages.length - 1],
          messages.length - 1,
        );
      } else {
        let dropped = messages.length - kept.length;

        // No half-present turns: an assistant answer must not survive
        // without the user prompt it answers. Never empty the transcript
        // to satisfy it.
        if (kept.length > 1 && kept[0].role === "assistant") {
          kept = kept.slice(1);
          dropped += 1;
        }

        // Terminal check: the marker itself costs bytes. Keep dropping the
        // oldest kept turn until the *complete* payload fits.
        finalPayload = buildPayload(withMarker(kept, dropped, false));
        while (Buffer.byteLength(finalPayload, "utf8") > MAX_TRANSCRIPT_BYTES && kept.length > 1) {
          kept = kept.slice(1);
          dropped += 1;
          if (kept.length > 1 && kept[0].role === "assistant") {
            kept = kept.slice(1);
            dropped += 1;
          }
          finalPayload = buildPayload(withMarker(kept, dropped, false));
        }

        // One turn left and the marker still pushes past the cap: cut the
        // turn's content rather than ship an empty transcript.
        if (Buffer.byteLength(finalPayload, "utf8") > MAX_TRANSCRIPT_BYTES) {
          finalPayload = buildSingleOversized(kept[0], dropped);
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
