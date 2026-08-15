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

/** Truncate a turn's content to fit within a byte budget, with marker. */
function truncateTurnContent(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) {
    return content;
  }
  let truncated = content;
  while (Buffer.byteLength(truncated, "utf8") > maxBytes - 20) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + "…[turn truncated]";
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
      let rendered = inputStr;
      if (Buffer.byteLength(inputStr, "utf8") > MAX_BLOCK_BYTES) {
        // Truncate by bytes, not by character count
        let truncated = inputStr;
        while (Buffer.byteLength(truncated, "utf8") > MAX_BLOCK_BYTES - 15) {
          truncated = truncated.slice(0, -1);
        }
        rendered = truncated + "…[truncated]";
      }
      return `[tool_use: ${name}] ${rendered}`;
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
    if (Buffer.byteLength(rendered, "utf8") > MAX_BLOCK_BYTES) {
      // Truncate by bytes, not by character count
      let truncated = rendered;
      while (Buffer.byteLength(truncated, "utf8") > MAX_BLOCK_BYTES - 15) {
        truncated = truncated.slice(0, -1);
      }
      rendered = truncated + "…[truncated]";
    }
    return `[tool_result] ${rendered}`;
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

    // Truncate at turn granularity to fit within payload cap (measured in UTF-8 bytes).
    let transcript = messages;
    let elisionMarker = "";
    let turnTruncated = false;

    // Build the final payload and check if it fits.
    const buildPayload = (msgs: typeof messages) => {
      const payload = {
        session_id: sessionId,
        messages: msgs,
        tool_calls: [] as unknown[],
      };
      return JSON.stringify(payload);
    };

    let finalPayload = buildPayload(transcript);
    const payloadBytes = Buffer.byteLength(finalPayload, "utf8");

    // If transcript exceeds cap, keep newest turns and drop from oldest.
    if (payloadBytes > MAX_TRANSCRIPT_BYTES) {
      transcript = [];
      let droppedCount = messages.length;

      for (let i = messages.length - 1; i >= 0; i--) {
        const candidate = messages[i];
        const testTranscript = [candidate, ...transcript];

        // Check if adding this turn would fit.
        let testPayload = buildPayload(testTranscript);
        let testBytes = Buffer.byteLength(testPayload, "utf8");

        if (testBytes <= MAX_TRANSCRIPT_BYTES) {
          transcript = testTranscript;
          droppedCount = i;
        } else {
          // This turn would cause overflow. Check if it's the newest turn (i === messages.length - 1).
          if (i === messages.length - 1 && transcript.length === 0) {
            // Newest turn alone exceeds cap. Keep it but truncate its content.
            const truncatedContent = truncateTurnContent(candidate.content, MAX_TRANSCRIPT_BYTES / 2);
            transcript = [{ role: candidate.role, content: truncatedContent }];
            turnTruncated = true;
            droppedCount = i;
            break;
          } else {
            // Older turn would overflow; stop here.
            break;
          }
        }
      }

      // Ensure transcript never starts with assistant message (need user first).
      if (transcript.length > 0 && transcript[0].role === "assistant") {
        transcript = transcript.slice(1);
        droppedCount += 1;
      }

      // Add elision marker if turns were dropped and we have content.
      if (droppedCount > 0 && transcript.length > 0 && !turnTruncated) {
        elisionMarker = `[${droppedCount} turns elided]`;
        transcript = [{ role: "system", content: elisionMarker }, ...transcript];
      } else if (turnTruncated && transcript.length > 0) {
        elisionMarker = `[${droppedCount} turns elided, newest turn truncated]`;
        transcript = [{ role: "system", content: elisionMarker }, ...transcript];
      }
    }

    // Rebuild final payload to ensure it's under the cap.
    finalPayload = buildPayload(transcript);

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
