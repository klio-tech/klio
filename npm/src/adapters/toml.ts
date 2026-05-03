// Minimal hand-rolled TOML reader/writer for the Codex MCP config
// subset.
//
// Codex's `~/.codex/config.toml` is hand-edited by users. Round-
// tripping through a generic TOML parser/serialiser would lose
// comments, blank lines, and stable key ordering — and we don't
// want to ship a TOML dependency just to mutate two tables.
//
// Instead, we treat the file as a source string and do surgical
// edits on the `[mcp_servers.<name>]` and `[mcp_servers.<name>.env]`
// blocks we own. Anything else in the file passes through byte-for-
// byte.
//
// Subset we support (everything else is left untouched):
//   - top-level tables `[mcp_servers.<name>]`
//   - the optional sub-table `[mcp_servers.<name>.env]`
//   - scalar string values: `key = "value"`
//   - string arrays: `key = ["a", "b"]`
//
// We never *parse* values — we only locate block boundaries and
// rewrite the whole block. This keeps the code small enough to
// audit and removes a class of escaping bugs.

export type McpServerEntry = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

const TABLE_PREFIX = "[mcp_servers.";

/**
 * Locate the source range owned by [mcp_servers.<name>] (and any
 * sub-tables that hang off it, like [mcp_servers.<name>.env]) in the
 * raw TOML body.
 *
 * Returns character offsets `start..end` such that `body.slice(start,
 * end)` is the slice to replace. The slice always ends at the start
 * of the next unrelated header, or at end-of-input.
 *
 * The block ends at the next line that:
 *   - starts a top-level table `[...]` AND
 *   - is NOT `[mcp_servers.<name>]` itself AND
 *   - is NOT a `[mcp_servers.<name>.<anything>]` sub-table.
 *
 * Critically, we distinguish `[mcp_servers.klio.env]` (a sub-table
 * we own) from `[mcp_servers.klio_other]` (an unrelated server with
 * a name that happens to share a prefix) by requiring a literal `.`
 * after the name.
 */
function findBlockRange(
  body: string,
  name: string,
): { start: number; end: number } | null {
  const header = `[mcp_servers.${name}]`;
  const subTablePrefix = `[mcp_servers.${name}.`;

  const lines = body.split("\n");

  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === header) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) return null;

  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith("[")) continue;
    // Another table header. Is it ours (sub-table) or someone else's?
    if (t === header) continue; // shouldn't happen on valid TOML, but tolerate
    if (t.startsWith(subTablePrefix)) continue;
    endLine = i;
    break;
  }

  // Convert line indices back to character offsets in the original
  // body. `body.split("\n")` produces N+1 segments where N is the
  // number of "\n" characters; the join boundaries are exactly at
  // each newline. Walking the join boundaries gives us the offset
  // of the start of any line.
  const start = lineStartOffset(lines, startLine);
  const end = lineStartOffset(lines, endLine);
  return { start, end };
}

/**
 * Offset (in characters) of the start of `lines[index]` within the
 * original `lines.join("\n")` source.
 *
 * `body.split("\n")` is the inverse of `lines.join("\n")`: there are
 * exactly `lines.length - 1` newline characters in the joined source,
 * one between every adjacent pair of segments. So the start of
 * `lines[index]` sits at `sum(lines[0..index].length) + index` —
 * one newline accounting for each preceding segment boundary.
 *
 * When `index === lines.length` the returned offset is the source
 * length (i.e. one past the last byte), which is exactly what we
 * want for the "block extends to end-of-file" case.
 */
function lineStartOffset(lines: string[], index: number): number {
  let offset = 0;
  for (let i = 0; i < index; i++) {
    offset += lines[i].length + 1; // +1 for the "\n" that follows lines[i]
  }
  // When index === lines.length we counted one extra newline (there
  // are only lines.length-1 newlines in the source).
  if (index === lines.length && index > 0) {
    offset -= 1;
  }
  return offset;
}

/**
 * Render a [mcp_servers.<name>] block (plus optional .env sub-table)
 * as a TOML string. Always ends with a single trailing newline so
 * inserting it adjacent to other content yields a well-formed file.
 *
 * String escaping uses `JSON.stringify` because TOML basic strings
 * share JSON's `"..."` syntax for the subset we emit (no multi-line,
 * no literal strings). This handles quotes, backslashes, and control
 * characters consistently.
 */
function renderEntry(name: string, entry: McpServerEntry): string {
  const lines: string[] = [];
  lines.push(`[mcp_servers.${name}]`);
  lines.push(`command = ${JSON.stringify(entry.command)}`);
  lines.push(
    `args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]`,
  );

  const env = entry.env ?? {};
  if (Object.keys(env).length > 0) {
    lines.push("");
    lines.push(`[mcp_servers.${name}.env]`);
    for (const [k, v] of Object.entries(env)) {
      lines.push(`${k} = ${JSON.stringify(v)}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Insert or replace the [mcp_servers.<name>] block in `body`.
 *
 * - If the block is absent, append it after a single blank-line
 *   separator (or, for an empty body, write it as the entire file).
 * - If the block is present, replace its source range in place,
 *   leaving every other byte of the file untouched.
 *
 * The result always ends with a newline.
 */
export function upsertMcpServer(
  body: string,
  name: string,
  entry: McpServerEntry,
): string {
  const rendered = renderEntry(name, entry);
  const range = findBlockRange(body, name);

  if (range) {
    return body.slice(0, range.start) + rendered + body.slice(range.end);
  }

  if (body.length === 0) return rendered;

  // Ensure exactly one blank line between prior content and the new
  // section. We compute the gap from the *current* trailing
  // whitespace so re-running the same operation can't keep growing
  // the gap.
  const trimmed = body.replace(/\n*$/, "");
  return trimmed + "\n\n" + rendered;
}

/**
 * Return the set of `<name>` values for which a [mcp_servers.<name>]
 * top-level table exists. Sub-tables like [mcp_servers.<name>.env]
 * are intentionally excluded — they are not standalone servers.
 */
export function parseMcpServers(body: string): Set<string> {
  const out = new Set<string>();
  for (const raw of body.split("\n")) {
    const t = raw.trim();
    if (!t.startsWith(TABLE_PREFIX) || !t.endsWith("]")) continue;
    const inside = t.slice(TABLE_PREFIX.length, -1);
    if (inside.length === 0) continue;
    if (inside.includes(".")) continue; // skip sub-tables
    out.add(inside);
  }
  return out;
}

/**
 * Remove the [mcp_servers.<name>] block (and its sub-tables) from
 * the source. No-op when the block is absent.
 */
export function removeMcpServer(body: string, name: string): string {
  const range = findBlockRange(body, name);
  if (!range) return body;
  return body.slice(0, range.start) + body.slice(range.end);
}
