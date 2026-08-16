// Reading OpenAI's Responses API — the shape Codex speaks.
//
// This module is READ-ONLY over the request. It answers two questions
// the proxy needs and nothing else: "what should we recall on?" and
// "what conversation should we capture?". The one WRITE the proxy
// performs on this shape lives in inject.ts and touches `instructions`
// alone.
//
// The shapes below are not inferred from documentation. They were
// recorded off the wire from codex-cli 0.39.0 with
// `wire_api = "responses"`, through a transparent relay, on 2026-08-16:
//
//   {
//     "model": "...", "instructions": "<~24 KB string>",
//     "input": [
//       { "type": "message", "role": "user",
//         "content": [{ "type": "input_text", "text": "..." }] },
//       { "type": "function_call", "name": "shell",
//         "arguments": "{\"command\":[\"bash\",\"-lc\",\"ls\"]}",
//         "call_id": "call_..." },
//       { "type": "function_call_output", "call_id": "call_...",
//         "output": "{\"output\":\"...\",\"metadata\":{...}}" }
//     ],
//     "tools": [...], "tool_choice": "auto", "parallel_tool_calls": false,
//     "reasoning": null, "store": false, "stream": true, "include": [],
//     "prompt_cache_key": "..."
//   }
//
// `input` may also be a bare string (the API's simplest form), and
// message items may carry a plain string `content` instead of the typed
// part array. Both are handled; anything else is skipped rather than
// guessed at.

import { renderToolResult, renderToolUse, seedOf } from "./transcript.js";

/**
 * One input item, normalised. `raw` is kept because the session id is
 * seeded from the UNRENDERED item — rendering applies the per-block
 * cap, and two conversations whose opening tool call differs only past
 * 8000 bytes would otherwise hash identically and clobber each other.
 * Same discipline as the Messages path.
 */
export type ResponsesTurn = { raw: unknown; role: string; content: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** The `input` array, normalised from either accepted form. */
function inputItems(parsed: unknown): unknown[] {
  const body = asRecord(parsed);
  if (body === null) return [];
  const input = body["input"];
  if (typeof input === "string") {
    return input === "" ? [] : [{ type: "message", role: "user", content: input }];
  }
  return Array.isArray(input) ? input : [];
}

/**
 * Text of a `message` item's content — a plain string, or the typed
 * part array (`input_text` on the way in, `output_text` on the way
 * back). Parts of any other type (`input_image`, `input_file`, …) carry
 * no text and are skipped, exactly as unknown Anthropic blocks are.
 */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const p = asRecord(part);
      if (p === null) return "";
      const type = p["type"];
      if (type !== "input_text" && type !== "output_text" && type !== "summary_text") return "";
      const text = p["text"];
      return typeof text === "string" ? text : "";
    })
    .filter((t) => t !== "")
    .join("\n");
}

/**
 * Normalise one input item into a turn, or null when it carries no
 * evidence.
 *
 * Roles are assigned by ITEM TYPE, not by a `role` field that most item
 * types do not have. A `function_call` is something the model emitted,
 * so it is an assistant turn; a `function_call_output` is the harness
 * answering, which is the user side — the same placement the Messages
 * path gives a `tool_result` block, which arrives inside a user
 * message. Getting this backwards would hand the grader a transcript in
 * which the model appears to have produced its own tool output.
 *
 * Items that render to nothing (`reasoning`, an unknown future type, a
 * bare string in the array) return null and are DROPPED. Dropping is
 * not the same failure as the Messages path's "a bare string makes the
 * whole conversation uncapturable": there, `messages` is a closed
 * vocabulary of two roles and an unrecognised entry means the body is
 * not what we think it is. Here the item vocabulary is open and
 * versioned by OpenAI, so a type we have not seen is expected, and
 * discarding a whole session's evidence over one is the wrong trade.
 * Nothing is fabricated either way — a dropped item contributes no turn.
 */
function toTurn(item: unknown): ResponsesTurn | null {
  const it = asRecord(item);
  if (it === null) return null;

  const type = it["type"];

  if (type === "function_call") {
    let input: unknown = it["arguments"];
    if (typeof input === "string") {
      // Codex sends `arguments` as a JSON STRING. Re-render it as the
      // object it represents so the transcript reads the same as the
      // Messages path's `tool_use.input`, which is already an object.
      try {
        input = JSON.parse(input) as unknown;
      } catch {
        // Not JSON after all — keep the raw string.
      }
    }
    return { raw: item, role: "assistant", content: renderToolUse(it["name"], input) };
  }

  if (type === "function_call_output" || type === "computer_call_output") {
    const output = it["output"];
    const rendered = typeof output === "string" ? output : seedOf(output);
    return { raw: item, role: "user", content: renderToolResult(rendered) };
  }

  // A `message` item, or the simplified form with a role and no type.
  //
  // The message's TEXT is passed through uncapped, on purpose. The
  // 8 KB per-block cap belongs to tool blocks — `renderToolUse` and
  // `renderToolResult` apply it, exactly as `renderBlock` does on the
  // Messages path, where a `text` block is returned untouched. Applying
  // it here too made this path silently lossier than the one capture.ts
  // promises it matches: a 50 KB paste (a stack trace, a log, a diff)
  // arrived whole through Claude Code and came out of Codex at 7998
  // characters with a truncation marker, while sitting well inside the
  // 256 KB payload cap that is supposed to be the only thing deciding
  // what survives. Turn-granular truncation and the total payload cap
  // (capture.ts) still govern the whole transcript.
  if (type === "message" || (type === undefined && it["role"] !== undefined)) {
    const role = String(it["role"] ?? "user").trim() || "user";
    const content = messageText(it["content"]);
    if (content === "") return null;
    return { raw: item, role, content };
  }

  return null;
}

/** Every capturable turn of a Responses request, in order. */
export function responsesTurns(parsed: unknown): ResponsesTurn[] {
  return inputItems(parsed)
    .map((item) => toTurn(item))
    .filter((t): t is ResponsesTurn => t !== null);
}

/**
 * The query the recaller receives: the most recent USER item that
 * actually carries text.
 *
 * Same rule, and the same reason, as `lastUserMessageText` on the
 * Messages path. Codex's agent loop resends the whole conversation with
 * a `function_call_output` on the end every iteration; reading "the last
 * user item" literally would yield the tool output — or nothing — on the
 * majority of turns, and injection would go inert for exactly the agent
 * this path exists to serve. Falling back to the last user item WITH
 * TEXT also keeps `instructions` byte-stable across the loop, so the
 * model's cached prompt prefix is not invalidated every turn.
 *
 * A rendered `[tool_result] …` is never a query: `toTurn` gives those
 * role "user", so they are skipped explicitly here by item type rather
 * than by role.
 */
export function lastUserInputText(parsed: unknown): string {
  const items = inputItems(parsed);
  for (let i = items.length - 1; i >= 0; i--) {
    const it = asRecord(items[i]);
    if (it === null) continue;
    const type = it["type"];
    if (type !== undefined && type !== "message") continue;
    if (String(it["role"] ?? "user").trim() !== "user") continue;
    const text = messageText(it["content"]);
    if (text.trim() !== "") return text;
  }
  return "";
}

const SSE_DATA_LINE = /^data:\s*(.+)$/;

/**
 * Best-effort assistant text out of a (possibly teed, possibly
 * truncated) Responses reply, for capture only. Never throws.
 *
 * Two forms, both observed live against a real `/v1/responses`:
 *
 *   * Non-streamed: `output` is an array of items; the assistant's
 *     words are in `message` items' `output_text` parts.
 *   * Streamed: `response.output_text.delta` events whose `delta` is a
 *     STRING — not the `{ delta: { text } }` object the Anthropic
 *     stream uses. Reading `delta.text` here returns "" for every
 *     event, which is precisely the kind of silent, plausible-looking
 *     nothing this proxy has shipped before.
 */
export function extractResponsesAssistantText(
  buf: Buffer,
  contentType: string | undefined,
): string {
  const text = buf.toString("utf8");

  if (contentType && contentType.includes("text/event-stream")) {
    const parts: string[] = [];
    for (const line of text.split("\n")) {
      const match = line.match(SSE_DATA_LINE);
      if (!match) continue;
      const payload = match[1].trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        const event = JSON.parse(payload) as Record<string, unknown>;
        if (event["type"] !== "response.output_text.delta") continue;
        const delta = event["delta"];
        if (typeof delta === "string") parts.push(delta);
      } catch {
        // Malformed or truncated SSE payload line — skip it.
      }
    }
    return parts.join("");
  }

  try {
    const parsed = asRecord(JSON.parse(text));
    if (parsed === null) return "";
    const output = parsed["output"];
    if (!Array.isArray(output)) return "";
    return output
      .map((item) => {
        const it = asRecord(item);
        if (it === null || it["type"] !== "message") return "";
        return messageText(it["content"]);
      })
      .filter((t) => t !== "")
      .join("\n");
  } catch {
    return "";
  }
}
