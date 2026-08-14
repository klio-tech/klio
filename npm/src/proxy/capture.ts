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

/**
 * Derive a session id from the conversation's FIRST user message, so
 * every turn of one conversation shares an id. The engine's
 * richer-transcript-wins upsert then keeps the fullest version rather
 * than fragmenting one session into forty rows.
 */
export function conversationSessionId(agent: string, messages: unknown[]): string {
  const firstUser = messages.find(
    (m) => (m as Record<string, unknown> | null)?.["role"] === "user",
  ) as Record<string, unknown> | undefined;
  const seed = firstUser ? JSON.stringify(firstUser["content"] ?? "") : "empty";
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 16);
  return `klio-proxy:${agent}:${hash}`;
}

/** Flatten Anthropic content (string or block array) to plain text. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b as Record<string, unknown>)?.["text"])
    .filter((t): t is string => typeof t === "string")
    .join("\n");
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

    const messages = rawMessages.map((m) => {
      const r = m as Record<string, unknown>;
      return { role: String(r["role"] ?? "user"), content: textOf(r["content"]) };
    });
    if (opts.assistantText.trim() !== "") {
      messages.push({ role: "assistant", content: opts.assistantText });
    }

    await doFetch(`${opts.config.baseUrl}/capture/transcript`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vex-Key": opts.config.apiKey,
        "X-Vex-Agent": opts.config.agentId,
      },
      body: JSON.stringify({
        session_id: conversationSessionId(opts.agent, rawMessages),
        messages,
        tool_calls: [],
      }),
    });
  } catch {
    // Best-effort by contract. A capture failure must never surface to
    // the agent, whose response has already been delivered.
  }
}
