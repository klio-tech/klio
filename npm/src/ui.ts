// Tiny step-runner UI that mirrors the Go orchestrator's output
// shape. Why duplicate it: the npm launcher and the Go-side
// `klio init` are two different entry points to the same product;
// users should see the same ✓ / ✗ / ! / — markers + timing
// regardless of which one they invoked.
//
// Zero runtime dependencies — just stdout + a few ANSI escapes.

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_RED = "\x1b[31m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_BOLD = "\x1b[1m";

function shouldColor(): boolean {
  if (process.env.NO_COLOR) return false;
  // FORCE_COLOR=1 wins (lets users keep colour in CI logs they pipe
  // through `tee` etc). Otherwise honour TTY detection.
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

const COLOR = shouldColor();

function paint(code: string, s: string): string {
  return COLOR ? `${code}${s}${ANSI_RESET}` : s;
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

export function banner(text: string): void {
  process.stdout.write(`${paint(ANSI_BOLD, text)}\n\n`);
}

export function startStep(title: string): void {
  process.stdout.write(`${paint(ANSI_CYAN, "▸")} ${title}…\n`);
}

export function ok(status: string, durationMs: number): void {
  const prefix = paint(ANSI_GREEN, "  ✓");
  const dur = paint(ANSI_DIM, `(${fmtDur(durationMs)})`);
  const message = status || "done";
  process.stdout.write(`${prefix} ${message} ${dur}\n`);
}

export function skip(reason: string): void {
  process.stdout.write(`${paint(ANSI_DIM, "  —")} ${paint(ANSI_DIM, reason)}\n`);
}

export function warn(message: string): void {
  process.stdout.write(`${paint(ANSI_YELLOW, "  !")} ${message}\n`);
}

export function fail(message: string): void {
  process.stdout.write(`${paint(ANSI_RED, "  ✗")} ${message}\n`);
}

export function info(line: string): void {
  for (const l of line.split("\n")) {
    if (!l.trim()) continue;
    process.stdout.write(
      `${paint(ANSI_DIM, "    ·")} ${paint(ANSI_DIM, l)}\n`,
    );
  }
}

export function newline(): void {
  process.stdout.write("\n");
}

export type StepResult =
  | { kind: "ok"; status?: string }
  | { kind: "skip"; reason: string }
  | { kind: "warn"; message: string };

export type Step = {
  title: string;
  /**
   * Optional steps that throw produce a yellow warning instead of
   * aborting the whole run. Used for ollama, where a missing model
   * server should not stop the user from getting the rest of the
   * stack.
   */
  optional?: boolean;
  run(): Promise<StepResult | void>;
};

export class StepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepError";
  }
}

/**
 * Run an array of steps in order, printing the structured progress
 * UI. A required step that throws aborts the run with exit code 1
 * (the orchestrator's caller is `cli.ts`, which lets the error
 * propagate and exits there). Optional steps that throw degrade to
 * a warning and the next step still runs.
 */
export async function runSteps(steps: Step[]): Promise<void> {
  for (const step of steps) {
    startStep(step.title);
    const start = Date.now();
    try {
      const result = await step.run();
      const dur = Date.now() - start;
      if (!result || result.kind === "ok") {
        ok(result?.status ?? "", dur);
      } else if (result.kind === "skip") {
        skip(result.reason);
      } else if (result.kind === "warn") {
        warn(result.message);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (step.optional) {
        warn(message);
        continue;
      }
      fail(message);
      throw err;
    }
  }
}
