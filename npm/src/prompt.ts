// Interactive readline-style prompt with defaults, validators and
// masked input. Why hand-roll instead of using `readline` directly:
//
//   1. We need character-by-character echo control for `mask: true`
//      (echo `•` per char rather than the literal key). `readline`
//      writes characters to the output stream as they're typed and
//      doesn't expose a hook to substitute them.
//   2. We want to drive the prompt from injected streams in tests
//      so we never block on real stdin.
//   3. Zero dependencies — no `inquirer`, no `prompts`. The npm
//      package's runtime closure stays empty.
//
// The implementation reads stdin one chunk at a time and accumulates
// lines into a queue. Each `prompt()` call drains the next line from
// that queue. This works uniformly whether stdin is a TTY (which
// emits characters as the user types) or an injected
// `Readable.from([...])` (which emits the whole script in one chunk
// and then ends — common in unit tests).

import type { Readable, Writable } from "node:stream";

export type PromptOptions = {
  /** Question text shown before the cursor. */
  message: string;
  /**
   * Pre-filled value used when the user hits Enter on an empty line.
   * Rendered as `[default]` next to the message.
   */
  default?: string;
  /**
   * Returns null if the value is acceptable, or an error string to
   * show before re-prompting. Validation runs after default
   * substitution, so a validator only sees the final candidate value.
   */
  validate?: (value: string) => string | null;
  /**
   * If true, echo `•` for every character instead of the literal
   * key. Used for API key entry — the value never lands in the
   * scrollback.
   */
  mask?: boolean;
  /**
   * If true, accept input across multiple lines. The terminator is
   * an empty line (a line whose content is `""`). The previous lines
   * are joined with `\n` and returned as the prompt's value. Useful
   * for paste-friendly memory entries where the user may include
   * embedded newlines.
   *
   * Combining `multiline` with `mask` is rejected at runtime — the
   * combination has no coherent meaning (a multi-line masked secret
   * is not a thing this prompt is built for).
   */
  multiline?: boolean;
  /**
   * Override stdin/stdout. Defaults to process.stdin/stdout. The
   * primary consumer of these overrides is the test suite — runtime
   * callers should pass nothing.
   */
  stdin?: Readable;
  stdout?: Writable;
};

const DEFAULT_REQUIRED_ERROR = "value required";

/**
 * Prompt the user for a single line of input. Resolves with the
 * accepted value (post-validation, post-default-substitution).
 *
 * Re-prompts on validator failure or empty input when no default is
 * configured. There is no built-in retry cap — the caller's flow is
 * expected to provide a way out (Ctrl-C / EOF on stdin).
 */
export async function prompt(opts: PromptOptions): Promise<string> {
  if (opts.mask && opts.multiline) {
    throw new Error("prompt: `mask` and `multiline` cannot be combined");
  }

  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const reader = createLineReader(stdin, stdout, opts.mask ?? false);

  try {
    if (opts.multiline) {
      return await readMultiline(stdout, reader, opts);
    }
    while (true) {
      renderQuestion(stdout, opts);
      const value = await reader.readLine();
      const final = value === "" && opts.default ? opts.default : value;

      if (opts.validate) {
        const err = opts.validate(final);
        if (err) {
          stdout.write(`      ✗ ${err}\n`);
          continue;
        }
      }

      if (!final && !opts.default) {
        stdout.write(`      ✗ ${DEFAULT_REQUIRED_ERROR}\n`);
        continue;
      }

      return final;
    }
  } finally {
    reader.dispose();
  }
}

/**
 * Read input until the user enters a blank line. The blank line is
 * the terminator and is NOT included in the returned value. Validator
 * runs once on the joined result; on failure we re-prompt the entire
 * block (consistent with single-line behaviour).
 */
async function readMultiline(
  stdout: Writable,
  reader: LineReader,
  opts: PromptOptions,
): Promise<string> {
  while (true) {
    renderQuestion(stdout, opts);
    const collected: string[] = [];
    while (true) {
      const line = await reader.readLine();
      if (line === "") break;
      collected.push(line);
    }
    const joined = collected.join("\n");
    const final = joined === "" && opts.default ? opts.default : joined;

    if (opts.validate) {
      const err = opts.validate(final);
      if (err) {
        stdout.write(`      ✗ ${err}\n`);
        continue;
      }
    }

    if (!final && !opts.default) {
      stdout.write(`      ✗ ${DEFAULT_REQUIRED_ERROR}\n`);
      continue;
    }

    return final;
  }
}

function renderQuestion(stdout: Writable, opts: PromptOptions): void {
  const def = opts.default ? ` [${opts.default}]` : "";
  stdout.write(`    ${opts.message}${def} › `);
}

type LineReader = {
  readLine(): Promise<string>;
  dispose(): void;
};

/**
 * Build a line-oriented reader on top of a raw byte stream. The
 * reader maintains an internal queue of completed lines plus a
 * partial-line buffer. Each call to `readLine()` returns the next
 * complete line, awaiting more data if the queue is empty.
 *
 * In masked mode every printable character emits `•` to stdout as
 * it's read; backspace (\b or DEL/0x7f) erases the last char both
 * from the buffer and from the user's view via the standard
 * `\b \b` ANSI sequence.
 */
function createLineReader(
  stdin: Readable,
  stdout: Writable,
  mask: boolean,
): LineReader {
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let partial = "";
  let ended = false;
  let endError: Error | undefined;
  // Track whether we've explicitly disposed so the data handler can
  // bail without writing further to stdout (the test Writable may
  // have been closed in a finally block).
  let disposed = false;
  // Whether the previous character was a bare \r. When true, a
  // following \n is part of a Windows-style CRLF terminator and
  // should be swallowed rather than emitting a second (empty) line.
  let prevWasCR = false;

  const enqueue = (line: string): void => {
    const next = waiters.shift();
    if (next) next(line);
    else lines.push(line);
  };

  const handleChunk = (chunk: Buffer | string): void => {
    if (disposed) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const ch of text) {
      if (ch === "\n" && prevWasCR) {
        // CRLF — the \r already terminated the line; swallow this \n.
        prevWasCR = false;
        continue;
      }
      if (ch === "\n" || ch === "\r") {
        prevWasCR = ch === "\r";
        if (mask) stdout.write("\n");
        const line = partial;
        partial = "";
        enqueue(line);
        continue;
      }
      prevWasCR = false;
      if (mask) {
        if (ch === "\b" || ch.charCodeAt(0) === 127) {
          if (partial.length > 0) {
            partial = partial.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        partial += ch;
        stdout.write("•");
        continue;
      }
      partial += ch;
    }
  };

  const handleEnd = (): void => {
    ended = true;
    // Flush any trailing partial as a final line so callers waiting
    // on input from a stream that didn't terminate with \n still
    // resolve. This matches readline's behaviour.
    if (partial.length > 0) {
      const line = partial;
      partial = "";
      enqueue(line);
    }
    // Wake any waiters still pending — they'll see an empty line
    // and the validator/default logic will decide whether to retry.
    while (waiters.length > 0) {
      const w = waiters.shift();
      if (w) w("");
    }
  };

  const handleError = (err: Error): void => {
    endError = err;
    handleEnd();
  };

  stdin.on("data", handleChunk);
  stdin.once("end", handleEnd);
  stdin.once("error", handleError);

  return {
    readLine(): Promise<string> {
      if (lines.length > 0) {
        return Promise.resolve(lines.shift() as string);
      }
      if (ended) {
        if (endError) return Promise.reject(endError);
        return Promise.resolve("");
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    dispose(): void {
      disposed = true;
      stdin.off("data", handleChunk);
      stdin.off("end", handleEnd);
      stdin.off("error", handleError);
    },
  };
}
