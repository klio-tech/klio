// The one transform this proxy applies: append recalled memories to the
// request's `system` field.
//
// The constraint that binds here is NOT "never parse bodies" — that
// described how the pass-through stage achieved its guarantee. What
// binds is: DO NOT BREAK `tool_reference` BLOCKS. Pointing
// ANTHROPIC_BASE_URL at a non-Anthropic host disables MCP Tool Search;
// `klio init` re-enables it, and that only works if tool_reference
// blocks survive the hop. Getting it wrong costs ~85% on tool schemas
// SILENTLY, while Klio claims to be saving tokens.
//
// So this function reads `system` and nothing else, appends and never
// reorders, and verifies byte-stability that every other top-level key
// is untouched before returning a mutated body. On any doubt it returns
// the original bytes.
//
// Byte-stability strategy: before mutating, verify the original body
// can round-trip through JSON stringify→parse→stringify without change.
// If not (e.g., pretty-printed bodies), return unchanged — fail-safe
// and the right default, since injection only fires on compact requests.
// This single check proves all non-system fields survive, since only
// system is mutated afterwards.

export type Memory = { id: string; content: string };

export type InjectResult = { body: Buffer; injected: number };

/** Header/label the model sees above injected context. */
const PREAMBLE = "Team context from Klio (shared memory — treat as established fact):";

function renderBlock(memories: Memory[]): string {
  const lines = memories.map((m) => `- ${m.content}`);
  return `${PREAMBLE}\n${lines.join("\n")}`;
}

function isValidSystemElement(elem: unknown): boolean {
  return typeof elem === "object" && elem !== null && !Array.isArray(elem) &&
    typeof (elem as Record<string, unknown>)["type"] === "string";
}

export function injectMemories(bodyBytes: Buffer, memories: Memory[]): InjectResult {
  const unchanged: InjectResult = { body: bodyBytes, injected: 0 };

  try {
    // Validate inputs
    if (!Buffer.isBuffer(bodyBytes) || !Array.isArray(memories)) return unchanged;
    if (memories.length === 0) return unchanged;

    // Filter memories to those with non-empty string content
    const validMemories = memories.filter(
      (m) => m && typeof m === "object" && typeof m.content === "string" && m.content.length > 0
    );
    if (validMemories.length === 0) return unchanged;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(bodyBytes.toString("utf8")) as Record<string, unknown>;
    } catch {
      return unchanged; // not JSON — forward verbatim
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return unchanged;

    // Byte-stability check: can the original round-trip unchanged?
    // If not, it's pretty-printed or has quirks (big integers, escape sequences, etc).
    // Skip injection on non-compact bodies — fail-safe.
    const byteCheck = Buffer.from(JSON.stringify(parsed), "utf8");
    if (!byteCheck.equals(bodyBytes)) return unchanged;

    const system = parsed["system"];
    const block = { type: "text", text: renderBlock(validMemories) };

    let nextSystem: unknown;
    if (system === undefined) {
      nextSystem = [block];
    } else if (typeof system === "string") {
      // Promote to the array form, original FIRST so the agent's own
      // instructions keep precedence in the model's reading order.
      nextSystem = [{ type: "text", text: system }, block];
    } else if (Array.isArray(system)) {
      // Validate all existing elements have proper shape before appending
      if (!system.every(isValidSystemElement)) return unchanged;

      // Idempotency guard: if the last element already has the injected preamble,
      // don't double-inject on proxy retry.
      const lastElem = system[system.length - 1] as Record<string, unknown>;
      if (lastElem && typeof lastElem === "object" && typeof lastElem.text === "string" &&
          lastElem.text.includes(PREAMBLE)) {
        return unchanged;
      }

      nextSystem = [...system, block];
    } else {
      // Some shape we do not understand. Do not guess.
      return unchanged;
    }

    const mutated = { ...parsed, system: nextSystem };
    let serialized: Buffer;
    try {
      serialized = Buffer.from(JSON.stringify(mutated), "utf8");
    } catch {
      return unchanged;
    }

    return { body: serialized, injected: validMemories.length };
  } catch {
    // Top-level guard: any error during injection, return unchanged.
    // A throw on the proxy request path would drop the request entirely.
    return unchanged;
  }
}
