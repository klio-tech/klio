// Rendering and truncation primitives shared by every wire shape the
// proxy captures.
//
// These were private to capture.ts while Anthropic's Messages API was
// the only shape captured. The Responses API (Codex) needs the same
// per-block byte cap, the same surrogate-safe truncation and the same
// `[tool_use: …]` / `[tool_result] …` rendering vocabulary, and the
// grader on the other end reads one transcript format regardless of
// which agent produced it — so the rendering rules have to live in one
// place rather than be re-derived per shape.
//
// Nothing here talks to the network or knows what a request looks like.

/** Max UTF-8 bytes per individual block (tool_use input, tool_result content). */
export const MAX_BLOCK_BYTES = 8000;

/** Marker appended to a turn whose own content had to be cut. */
export const TURN_TRUNCATED_SUFFIX = "…[turn truncated]";

/** Marker appended to a single content block that had to be cut. */
export const BLOCK_TRUNCATED_SUFFIX = "…[truncated]";

/** One rendered turn of the transcript as it is sent. */
export type Turn = { role: string; content: string };

/** UTF-8 bytes a code point occupies as-is. */
export function utf8Width(code: number): number {
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
export function jsonWidth(code: number): number {
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
export function truncateByCodePoints(
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
export function jsonBytesOf(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
}

/**
 * Truncate a turn's content to a budget expressed in JSON-escaped UTF-8
 * bytes, appending the truncation marker. The returned string is
 * guaranteed to serialize into at most `maxJsonBytes` bytes, and never
 * ends mid-surrogate-pair.
 */
export function truncateTurnContent(content: string, maxJsonBytes: number): string {
  if (jsonBytesOf(content) <= maxJsonBytes) return content;
  const budget = maxJsonBytes - jsonBytesOf(TURN_TRUNCATED_SUFFIX);
  // No room for even the marker: emit nothing rather than spin or overflow.
  // (The previous loop had no lower bound and spun forever for tiny budgets.)
  if (budget <= 0) return "";
  return truncateByCodePoints(content, budget, jsonWidth) + TURN_TRUNCATED_SUFFIX;
}

/** Truncate a rendered block to a raw UTF-8 byte budget, surrogate-safe. */
export function truncateBlock(rendered: string): string {
  if (Buffer.byteLength(rendered, "utf8") <= MAX_BLOCK_BYTES) return rendered;
  const budget = MAX_BLOCK_BYTES - Buffer.byteLength(BLOCK_TRUNCATED_SUFFIX, "utf8");
  if (budget <= 0) return "";
  return truncateByCodePoints(rendered, budget, utf8Width) + BLOCK_TRUNCATED_SUFFIX;
}

/** `[tool_use: name] {json}`, capped, never throwing on unserializable input. */
export function renderToolUse(name: unknown, input: unknown): string {
  try {
    return `[tool_use: ${String(name)}] ${truncateBlock(JSON.stringify(input) ?? "")}`;
  } catch {
    // Circular or unserializable input; render safely.
    return `[tool_use: ${String(name)}] [unserializable input]`;
  }
}

/** `[tool_result] …`, capped. */
export function renderToolResult(rendered: string): string {
  return `[tool_result] ${truncateBlock(rendered)}`;
}

/** Render a single Anthropic content block to text. */
export function renderBlock(block: unknown): string {
  if (!block || typeof block !== "object") return "";
  const b = block as Record<string, unknown>;
  const type = b["type"];

  if (type === "text") {
    const text = b["text"];
    return typeof text === "string" ? text : "";
  }

  if (type === "tool_use") return renderToolUse(b["name"], b["input"]);

  if (type === "tool_result") {
    const contentValue = b["content"];
    let rendered = "";
    if (typeof contentValue === "string") {
      rendered = contentValue;
    } else if (Array.isArray(contentValue)) {
      rendered = contentValue.map((c) => renderBlock(c)).filter((t) => t !== "").join("\n");
    }
    return renderToolResult(rendered);
  }

  // Unknown block types are skipped.
  return "";
}

/** Render Anthropic content (string or block array) to plain text. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => renderBlock(b))
    .filter((t) => t !== "")
    .join("\n");
}

/** Serialize for hashing. Never throws; unserializable input falls back. */
export function seedOf(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
