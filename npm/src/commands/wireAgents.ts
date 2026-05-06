/**
 * Adapter-detection + wiring shared between `klio init` Phase 4 and
 * `klio update agents`. Both call sites get the same behaviour:
 * detect installed AI agents, ask the user to confirm wiring,
 * call each adapter's `install()` (which performs its own backup),
 * and report per-adapter success/failure back to the caller.
 *
 * Extracted from `commands/init.ts` in v0.5.0 (Task E3) so the
 * recovery path `klio update agents` doesn't have to duplicate the
 * detection + wiring logic. The 0.4.1 production bug — a user who
 * typed memory text at the wire-tools confirm prompt skipped all
 * six adapters silently — is the reason the recovery path exists,
 * and centralising the logic guarantees both entry points pick up
 * future hardening (re-prompting `askConfirm`, new adapters added
 * to `allAdapters()`) for free.
 *
 * Pure orchestration: depends only on `allAdapters()`, `askConfirm`,
 * and `prompt` — no global state, no module-level mutation. Both
 * call sites pass their own `log` sink (init uses its `writeLine`
 * helper, update writes directly to its configured stdout) so the
 * shared function does not assume process.stdout.
 */
import { allAdapters } from "../adapters/types.js";
import { askConfirm } from "../confirm.js";
import { prompt } from "../prompt.js";

/** Inputs for `wireDetectedAgents`. Defaults are fine for production. */
export type WireAgentsOptions = {
  /**
   * Container name passed into each adapter's `install()`. Production
   * value is the `BRIDGE_CONTAINER` constant ("klio-bridge"); a future
   * `--profile` flag can pass a different value to keep parallel
   * stacks pointed at independent bridges.
   */
  bridgeContainer: string;
  /**
   * Env-var bag attached to every adapter's MCP/hook entry. Init
   * passes an empty object today; left here as a seam for a future
   * surface that wants to thread KLIO_DOCKER_BRIDGE etc. without
   * editing every call site.
   */
  env: Record<string, string>;
  /**
   * Sink for each line of user-facing output. Defaults to
   * `process.stdout.write(line + "\n")`. Production callers pass
   * their own sinks (init's `writeLine`, update's stdout write) so
   * tests can drive the function with a captured array.
   */
  log?: (line: string) => void;
};

/**
 * Outcome of one wire-agents invocation. Both call sites map this
 * back into their own surface (init mutates its phase-state struct,
 * update prints a one-line summary).
 */
export type WireAgentsResult = {
  /** Adapters whose `install()` resolved successfully. */
  configured: string[];
  /**
   * Adapters whose `install()` threw. Each entry carries the
   * adapter `name()` plus the formatted error message so the
   * caller can render `<name>: <message>` without re-extracting.
   */
  errored: { name: string; message: string }[];
  /**
   * True when no adapters were installed — either none were
   * detected on the host, or the user answered "no" at the
   * wire-tools confirm. Distinguished from a successful run with
   * an empty `configured` array (which only happens if every
   * detected adapter errored).
   */
  skipped: boolean;
};

/**
 * The default log sink. Pulled out as a named constant so tests can
 * compare references when they want to assert "the caller passed no
 * sink" (rare, but the seam is here).
 */
const defaultLog = (line: string): void => {
  process.stdout.write(line + "\n");
};

/**
 * Detect installed adapters, confirm wiring with the user, and run
 * each `install()` with backups. Returns a result struct so the
 * caller can render its own summary — the shared function does not
 * itself print phase headers, separators, or error escalation
 * (init re-uses `phaseRecap`/stderr, update writes inline).
 */
export async function wireDetectedAgents(
  opts: WireAgentsOptions,
): Promise<WireAgentsResult> {
  const log = opts.log ?? defaultLog;

  const detected = allAdapters().filter((a) => a.installed());
  if (detected.length === 0) {
    return { configured: [], errored: [], skipped: true };
  }

  const foundNames = detected.map((a) => a.name()).join(", ");
  const notFound = allAdapters().filter((a) => !a.installed());
  log("");
  log(`    Found:     ${foundNames}`);
  if (notFound.length > 0) {
    const skipNames = notFound.map((a) => a.name()).join(", ");
    log(`    Not found: ${skipNames} (skipping)`);
  }
  log("");

  // Re-prompting confirm — the 0.4.2 hardening that protects against
  // the "user typed memory text at the prompt" class of bug. A
  // single-shot `isYes` check would silently skip all adapters on
  // any non-y reply.
  const wireAll = await askConfirm(
    prompt,
    "Wire all detected tools?",
    true,
    log,
  );
  if (!wireAll) {
    return { configured: [], errored: [], skipped: true };
  }

  const configured: string[] = [];
  const errored: { name: string; message: string }[] = [];
  for (const adapter of detected) {
    try {
      await adapter.install({
        bridgeContainer: opts.bridgeContainer,
        env: opts.env,
      });
      configured.push(adapter.name());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errored.push({ name: adapter.name(), message: msg });
    }
  }

  if (configured.length > 0) {
    log(`  ✓ ${configured.join(" + ")} connected`);
  }
  // Per-adapter failures are returned in `errored` for the caller
  // to render — init writes them to stderr after `runSteps` returns
  // so they appear under the phase recap line; update prints them
  // inline because there's no phase header to wait for.
  return { configured, errored, skipped: false };
}
