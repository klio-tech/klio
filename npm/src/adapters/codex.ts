// Codex (OpenAI Codex CLI) adapter for the npm-launched flow.
//
// Codex reads MCP server registrations from `~/.codex/config.toml`
// under `[mcp_servers.<name>]` tables. The file is hand-edited by
// users (it also holds non-MCP settings like model defaults), so we
// must not round-trip it through a generic TOML library — that would
// drop comments, blank lines, and stable key ordering.
//
// We instead rely on `./toml.ts`, a hand-rolled minimal reader/writer
// scoped to the Codex MCP subset. It locates the [mcp_servers.<name>]
// block (and any [mcp_servers.<name>.env] sub-table) by line scan
// and rewrites only that slice, preserving every other byte of the
// file.
//
// Detection: we test for the existence of the `~/.codex` directory
// rather than the file itself. Codex creates `config.toml` lazily
// on first config write, so requiring the file would incorrectly
// report Codex as "not installed" for fresh installations.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Adapter, AdapterConfig } from "./types.js";
import { backupFile, restoreFromBackup } from "./fileutil.js";
import { removeMcpServer, upsertMcpServer } from "./toml.js";

export class CodexAdapter implements Adapter {
  name(): string {
    return "codex";
  }

  private codexDir(): string {
    return join(homedir(), ".codex");
  }

  private configPath(): string {
    return join(this.codexDir(), "config.toml");
  }

  installed(): boolean {
    // The directory is the install marker — config.toml may not
    // exist yet on a fresh Codex setup.
    return existsSync(this.codexDir());
  }

  async install(cfg: AdapterConfig): Promise<void> {
    const path = this.configPath();
    const prior = existsSync(path) ? readFileSync(path, "utf8") : "";

    // Only back up when there's something to restore. backupFile is
    // already a no-op for missing paths, but checking explicitly
    // keeps the intent clear and avoids polluting the directory
    // with empty backup files for new installs.
    if (existsSync(path)) backupFile(path);

    let next = upsertMcpServer(prior, "klio", {
      command: "docker",
      args: ["exec", "-i", cfg.bridgeContainer, "klio-mcp"],
      env: cfg.env,
    });

    // Pre-approve klio's MCP tools so Codex doesn't prompt the user
    // before each invocation. Codex's per-server approval-mode lives
    // under [apps.<server>] (sibling of [mcp_servers.<server>]):
    //
    //   [apps.klio]
    //   default_tools_approval_mode = "auto"
    //
    // Without it, the user sees an approval modal the first time
    // each of klio's 7 tools (recall/remember/observe/plan/decide/
    // note/space) fires — defeats the "memory just works" promise.
    //
    // Idempotent: appended only when not already present. A no-op
    // when Codex's TOML parser doesn't recognise the key (older
    // builds), since unknown TOML keys are silently ignored.
    next = ensureAppsKlioAutoApproval(next);

    writeFileSync(path, next, { mode: 0o644 });
  }

  async uninstall(): Promise<void> {
    const path = this.configPath();
    if (!existsSync(path)) return;

    try {
      restoreFromBackup(path);
      return;
    } catch {
      // No backup found — fall through to in-place strip. Partial
      // cleanup beats a hard failure when the user has pruned
      // backup files.
    }

    let stripped = removeMcpServer(readFileSync(path, "utf8"), "klio");
    stripped = removeAppsKlioAutoApproval(stripped);
    writeFileSync(path, stripped, { mode: 0o644 });
  }
}

/**
 * Append `[apps.klio]` with `default_tools_approval_mode = "auto"` to
 * a Codex config body if it isn't already present. Idempotent — re-
 * running install on the same body is a byte-identical no-op.
 *
 * We check via literal substring rather than parsing because:
 *   - the toml.ts editor only knows the [mcp_servers.<name>] subtree,
 *   - a user might have edited the block by hand (different
 *     formatting, additional sub-keys),
 *   - any presence of `[apps.klio]` means our intent is already
 *     declared even if values differ; respect that.
 */
function ensureAppsKlioAutoApproval(body: string): string {
  if (/\[apps\.klio\]/.test(body)) return body;
  // Bare block — no leading comment header. The TOML editor's
  // `upsertMcpServer` replaces the slice from `[mcp_servers.klio]`
  // up to the NEXT `[...]` header, so any comment lines between the
  // mcp_servers block and `[apps.klio]` would be stomped on the
  // second install (breaking idempotency). Keeping the block bare
  // means `findBlockRange`'s slice ends exactly at `[apps.klio]`,
  // making repeat installs byte-identical.
  const trailer = body.length === 0 || body.endsWith("\n") ? "" : "\n";
  return (
    body +
    trailer +
    "[apps.klio]\n" +
    'default_tools_approval_mode = "auto"\n'
  );
}

/**
 * Strip the [apps.klio] block (and any sub-keys until the next
 * top-level [...] header or EOF). Mirrors the conservative line-
 * scan style of toml.ts to keep peer content byte-stable.
 */
function removeAppsKlioAutoApproval(body: string): string {
  const lines = body.split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === "[apps.klio]");
  if (startIdx < 0) return body;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("[") && !t.startsWith("[apps.klio.")) {
      endIdx = i;
      break;
    }
  }

  // Also drop our own header comment block that immediately precedes
  // the [apps.klio] line (we wrote 3 commented-out lines above the
  // table header in `ensureAppsKlioAutoApproval`). Walk backwards
  // while lines start with `#` AND mention "klio".
  let trueStart = startIdx;
  while (
    trueStart > 0 &&
    lines[trueStart - 1].trimStart().startsWith("#") &&
    /klio/i.test(lines[trueStart - 1])
  ) {
    trueStart--;
  }
  // Also drop one blank line before the header block, if present, so
  // we don't leak an extra newline gap on uninstall.
  if (trueStart > 0 && lines[trueStart - 1].trim() === "") {
    trueStart--;
  }

  const before = lines.slice(0, trueStart);
  const after = lines.slice(endIdx);
  return [...before, ...after].join("\n");
}
