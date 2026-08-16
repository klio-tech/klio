// The one transform this proxy applies: append recalled memories to the
// request's system-level guidance field — `system` on Anthropic's
// Messages API, `instructions` on OpenAI's Responses API (Codex).
//
// Two wire shapes, ONE rule, and the rule is the point: touch exactly
// one field, append only, and never read, rewrite or reorder the
// conversation, the tools array, or any tool-reference construct.
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

/**
 * Everything both wire shapes must agree on before a single byte is
 * changed: usable memories, a JSON object body, and — the load-bearing
 * one — proof that the original body round-trips through
 * stringify→parse→stringify unchanged. Returns null when anything at
 * all is off, which every caller turns into "forward the original".
 *
 * Verified against three REAL Codex requests recorded off the wire
 * (26–27 KB each, 24 KB `instructions`, tools and typed input items):
 * all three round-trip byte-identically, so this guard admits real
 * Codex traffic rather than silently disabling injection for it.
 */
function prepare(
  bodyBytes: Buffer,
  memories: Memory[],
): { parsed: Record<string, unknown>; memories: Memory[] } | null {
  if (!Buffer.isBuffer(bodyBytes) || !Array.isArray(memories)) return null;
  if (memories.length === 0) return null;

  const validMemories = memories.filter(
    (m) => m && typeof m === "object" && typeof m.content === "string" && m.content.length > 0,
  );
  if (validMemories.length === 0) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyBytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    return null; // not JSON — forward verbatim
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  // Byte-stability check: can the original round-trip unchanged?
  // If not, it's pretty-printed or has quirks (big integers, escape sequences, etc).
  // Skip injection on non-compact bodies — fail-safe.
  const byteCheck = Buffer.from(JSON.stringify(parsed), "utf8");
  if (!byteCheck.equals(bodyBytes)) return null;

  return { parsed, memories: validMemories };
}

/** Serialize a mutated body, or give up and forward the original. */
function serialize(mutated: Record<string, unknown>, injected: number, original: Buffer): InjectResult {
  try {
    return { body: Buffer.from(JSON.stringify(mutated), "utf8"), injected };
  } catch {
    return { body: original, injected: 0 };
  }
}

export function injectMemories(bodyBytes: Buffer, memories: Memory[]): InjectResult {
  const unchanged: InjectResult = { body: bodyBytes, injected: 0 };

  try {
    const ready = prepare(bodyBytes, memories);
    if (ready === null) return unchanged;
    const { parsed, memories: validMemories } = ready;

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

    return serialize({ ...parsed, system: nextSystem }, validMemories.length, bodyBytes);
  } catch {
    // Top-level guard: any error during injection, return unchanged.
    // A throw on the proxy request path would drop the request entirely.
    return unchanged;
  }
}

/**
 * The same transform for OpenAI's Responses API — the shape Codex
 * speaks (`wire_api = "responses"`, proxy/codexProxy.ts).
 *
 * The one field is `instructions`. On the Responses API the
 * conversation lives in `input` (a string, or an array of typed items:
 * `message`, `function_call`, `function_call_output`, `reasoning`) and
 * the system-level guidance lives in `instructions`, a plain string.
 * Recorded off the wire from codex-cli 0.39.0: `instructions` is a
 * single ~24 KB string on every request of a session, and `input`
 * carries the whole conversation.
 *
 * `input` IS NEVER READ HERE, and never written. That is not fastidiousness
 * — a `function_call` and its `function_call_output` are matched by
 * `call_id`, and the Responses API rejects the request outright if a
 * call_id is orphaned or reordered. Appending a pseudo-turn to `input`
 * (the obvious alternative to touching `instructions`) would also put
 * Klio's text where the model reads it as part of the transcript rather
 * than as guidance. One field, appended to, or nothing.
 *
 * Unlike `system`, `instructions` has no array form: the API takes a
 * string. So the only mutation is string concatenation with the
 * original FIRST, keeping the agent's own instructions in front of ours
 * in the model's reading order — the same precedence rule the Messages
 * path applies. Any non-string, non-absent `instructions` is a shape we
 * do not understand, and it forwards unchanged rather than guessing.
 */
export function injectMemoriesResponses(bodyBytes: Buffer, memories: Memory[]): InjectResult {
  const unchanged: InjectResult = { body: bodyBytes, injected: 0 };

  try {
    const ready = prepare(bodyBytes, memories);
    if (ready === null) return unchanged;
    const { parsed, memories: validMemories } = ready;

    const instructions = parsed["instructions"];
    const block = renderBlock(validMemories);

    let nextInstructions: string;
    if (instructions === undefined) {
      nextInstructions = block;
    } else if (typeof instructions === "string") {
      // Idempotency guard: a proxy retry must not stack a second copy.
      if (instructions.includes(PREAMBLE)) return unchanged;
      // An empty string is still the string form — append without
      // manufacturing leading blank lines.
      nextInstructions = instructions === "" ? block : `${instructions}\n\n${block}`;
    } else {
      // Some shape we do not understand (null, array, object, number).
      // Do not guess.
      return unchanged;
    }

    return serialize(
      { ...parsed, instructions: nextInstructions },
      validMemories.length,
      bodyBytes,
    );
  } catch {
    return unchanged;
  }
}
