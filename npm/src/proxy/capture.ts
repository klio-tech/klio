// Emit a proxied conversation to the engine so agents WITHOUT hook
// support still feed the evidence loop.
//
// Capture lives in bridge/internal/hooks today, which reaches only
// harnesses that support hooks — in practice Claude Code. Anything
// else writes memories through MCP and is never retained, graded, or
// attributed. The proxy sees the whole conversation, so it is the one
// place those sessions can be captured.
//
// SCOPE, precisely: TWO wire shapes, sharing everything below the
// point where a request is read.
//
//   * Anthropic's Messages API — a POST whose path ends `/messages`.
//     Claude Code speaks it, though Claude Code no longer NEEDS this
//     path: its hooks capture the same sessions regardless of auth
//     mode, and under a Claude subscription its traffic never reaches a
//     custom base URL at all.
//   * OpenAI's Responses API — a POST whose path ends `/responses`.
//     Codex speaks it (`wire_api = "responses"`, proxy/codexProxy.ts),
//     and Codex has no hooks. THIS is the shape that makes the proxy
//     worth running.
//
// Everything past the shape-specific read — session-id derivation, the
// per-block cap, turn-granular truncation, the total payload cap, the
// `/capture/transcript` contract — is identical for both, deliberately:
// the grader on the other end reads one transcript format, and two
// truncation policies would be two sets of bugs.
//
// Strictly after the response is forwarded, strictly fire-and-forget.

import { createHash } from "node:crypto";

import type { CloudConfig } from "../cloudConfig.js";
import { responsesTurns } from "./responsesShape.js";
import {
  seedOf,
  textOf,
  truncateTurnContent,
  type Turn,
} from "./transcript.js";

export { renderBlock } from "./transcript.js";

/** Max UTF-8 bytes for the entire serialized transcript payload (256 KB). */
const MAX_TRANSCRIPT_BYTES = 256 * 1024;

/**
 * Below this much leftover room, a partially admitted turn carries no
 * useful evidence and is not worth the marker it costs.
 */
const MIN_FRAGMENT_BYTES = 512;

/** The wire shape a captured request was read from. */
export type CaptureShape = "messages" | "responses";

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

/**
 * A turn plus the RAW item it came from — the common currency both wire
 * shapes are read into, and the only thing anything below this point
 * knows about. `raw` exists so the session id keeps being seeded from
 * unrendered, untruncated content.
 */
type SourcedTurn = { raw: unknown; role: string; content: string };

/** Messages-shape read: every entry of `messages`, kept as-is. */
function messagesTurns(parsed: Record<string, unknown>): SourcedTurn[] {
  const raw = Array.isArray(parsed["messages"]) ? (parsed["messages"] as unknown[]) : [];
  return raw.map((m) => ({ raw: m, role: roleOf(m), content: textOf(contentOf(m)) }));
}

/**
 * Session id from already-read turns. The Messages path's
 * {@link conversationSessionId} is this function with its own read
 * applied first; the Responses path reuses it directly, so both shapes
 * get the identical stability and collision properties described below.
 */
function turnsSessionId(agent: string, turns: SourcedTurn[]): string | null {
  const firstUser = turns.find((t) => t.role === "user");
  const firstAssistant = turns.find((t) => t.role === "assistant");
  if (firstUser === undefined || firstAssistant === undefined) return null;

  const seed = seedOf(firstUser.raw) + "\n \n" + seedOf(firstAssistant.raw);
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 16);
  return `klio-proxy:${agent}:${hash}`;
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
  return turnsSessionId(
    agent,
    messages.map((m) => ({ raw: m, role: roleOf(m), content: "" })),
  );
}

export type EmitCaptureOptions = {
  config: CloudConfig;
  agent: string;
  requestBody: Buffer;
  assistantText: string;
  /**
   * Which wire shape `requestBody` is. Defaults to `"messages"` so
   * every existing caller and test keeps its behaviour unchanged;
   * `server.ts` always passes it explicitly.
   */
  shape?: CaptureShape;
  fetchImpl?: typeof fetch;
};

export async function emitCapture(opts: EmitCaptureOptions): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    if (!opts.config.apiKey) return;

    const parsed = JSON.parse(opts.requestBody.toString("utf8")) as Record<string, unknown>;

    // The ONLY shape-dependent step. Both readers produce the same
    // `{ raw, role, content }` currency: one read of the raw request,
    // one answer for both the session id and the rendered turn, so the
    // two can never disagree about whether a conversation has an
    // opening user turn — the divergence that once made whole
    // conversations silently uncapturable.
    const turns: SourcedTurn[] =
      opts.shape === "responses" ? responsesTurns(parsed) : messagesTurns(parsed);
    if (turns.length === 0) return;

    // Derive session ID from UNTRUNCATED, UNRENDERED turns (before any
    // truncation). This ensures the ID stays stable across turns and
    // prevents collisions.
    const sessionId = turnsSessionId(opts.agent, turns);
    // Skip capture entirely if there's no assistant turn yet.
    if (sessionId === null) return;

    const messages: Turn[] = turns.map((t) => ({ role: t.role, content: t.content }));
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
