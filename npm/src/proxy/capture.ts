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

/** Max bytes per individual block (tool_use input, tool_result content). */
const MAX_BLOCK_CHARS = 8000;

/** Max bytes for the entire transcript payload (256 KB). */
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

/** Render Anthropic content (string or block array) to plain text. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => renderBlock(b))
    .filter((t): t is string => t !== "")
    .join("\n");
}

/** Render a single content block to text. */
function renderBlock(block: unknown): string {
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
      const truncated =
        inputStr.length > MAX_BLOCK_CHARS
          ? inputStr.slice(0, MAX_BLOCK_CHARS) + "…[truncated]"
          : inputStr;
      return `[tool_use: ${name}] ${truncated}`;
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
    const truncated =
      rendered.length > MAX_BLOCK_CHARS
        ? rendered.slice(0, MAX_BLOCK_CHARS) + "…[truncated]"
        : rendered;
    return `[tool_result] ${truncated}`;
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

    // Truncate at turn granularity to fit within payload cap.
    let transcript = messages;
    let elisionMarker = "";
    const basePayload = {
      session_id: sessionId,
      tool_calls: [] as unknown[],
    };
    let payloadStr = JSON.stringify({ ...basePayload, messages: transcript });

    // If transcript exceeds cap, keep newest turns and drop from oldest.
    if (payloadStr.length > MAX_TRANSCRIPT_BYTES) {
      transcript = [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const testTranscript = [messages[i], ...transcript];
        const testPayload = JSON.stringify({ ...basePayload, messages: testTranscript });
        if (testPayload.length <= MAX_TRANSCRIPT_BYTES) {
          transcript = testTranscript;
        } else {
          // Adding this turn would exceed the cap; stop here.
          const droppedCount = i + 1;
          elisionMarker = `[${droppedCount} turns elided]`;
          break;
        }
      }
      // Prepend elision marker to the transcript if any turns were dropped.
      if (elisionMarker) {
        transcript = [{ role: "system", content: elisionMarker }, ...transcript];
      }
    }

    await doFetch(`${opts.config.baseUrl}/capture/transcript`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vex-Key": opts.config.apiKey,
        "X-Vex-Agent": opts.config.agentId,
      },
      body: JSON.stringify({
        session_id: sessionId,
        messages: transcript,
        tool_calls: [],
      }),
    });
  } catch {
    // Best-effort by contract. A capture failure must never surface to
    // the agent, whose response has already been delivered.
  }
}
