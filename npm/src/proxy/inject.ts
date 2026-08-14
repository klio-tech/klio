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
// reorders, and verifies by round-trip that every other top-level key
// is untouched before returning a mutated body. On any doubt it returns
// the original bytes.

export type Memory = { id: string; content: string };

export type InjectResult = { body: Buffer; injected: number };

/** Header/label the model sees above injected context. */
const PREAMBLE = "Team context from Klio (shared memory — treat as established fact):";

function renderBlock(memories: Memory[]): string {
  const lines = memories.map((m) => `- ${m.content}`);
  return `${PREAMBLE}\n${lines.join("\n")}`;
}

export function injectMemories(bodyBytes: Buffer, memories: Memory[]): InjectResult {
  const unchanged: InjectResult = { body: bodyBytes, injected: 0 };
  if (memories.length === 0) return unchanged;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyBytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    return unchanged; // not JSON — forward verbatim
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return unchanged;

  const system = parsed["system"];
  const block = { type: "text", text: renderBlock(memories) };

  let nextSystem: unknown;
  if (system === undefined) {
    nextSystem = [block];
  } else if (typeof system === "string") {
    // Promote to the array form, original FIRST so the agent's own
    // instructions keep precedence in the model's reading order.
    nextSystem = [{ type: "text", text: system }, block];
  } else if (Array.isArray(system)) {
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

  // Round-trip check: every top-level key except `system` must survive
  // byte-for-byte in meaning. This is what makes it safe to have parsed
  // at all — tools, tool_choice and messages are proven untouched.
  try {
    const reparsed = JSON.parse(serialized.toString("utf8")) as Record<string, unknown>;
    for (const key of Object.keys(parsed)) {
      if (key === "system") continue;
      if (JSON.stringify(reparsed[key]) !== JSON.stringify(parsed[key])) return unchanged;
    }
  } catch {
    return unchanged;
  }

  return { body: serialized, injected: memories.length };
}
