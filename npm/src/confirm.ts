/**
 * Yes/no confirmation prompts that are tolerant of unrecognized
 * input.
 *
 * Why this exists: 0.4.1 shipped a UX bug where every `[Y/n]` style
 * prompt in `klio init` silently collapsed any non-`y` input to "no".
 * A user who typed the next-step memory text at the wire-tools
 * confirm prompt by accident ("Abhishek Singh is good") had ALL six
 * agent adapters skipped without a warning, because the parser
 * treated arbitrary text as a no-answer.
 *
 * `askConfirm` re-prompts on unrecognized input and emits a "please
 * answer yes or no" hint between attempts. After a finite number of
 * unrecognized replies it falls back to the configured default
 * rather than spinning forever — protects against piped stdin or
 * exotic terminal states.
 *
 * Pure-orchestration module: depends only on a `promptFn` callback,
 * so unit tests can drive it with a scripted reply queue without
 * touching real stdio.
 */

import type { PromptOptions } from "./prompt.js";

/** Answer category. `empty` lets the caller apply its own default. */
export type YesNoToken = "yes" | "no" | "empty" | "unrecognized";

const YES_WORDS: ReadonlySet<string> = new Set(["y", "yes"]);
const NO_WORDS: ReadonlySet<string> = new Set(["n", "no"]);

/**
 * Maximum number of re-prompts before falling back to the default.
 * Five is generous for an honest typo and tight for a stuck stdin.
 * Each unrecognized attempt emits a hint, so the user sees five
 * helpful messages before the prompt gives up.
 */
const MAX_UNRECOGNIZED_RETRIES = 5;

/**
 * Classify a raw user answer into one of four buckets:
 *   - `yes` — affirmative ("y", "yes", any case, surrounding whitespace ok)
 *   - `no`  — negative   ("n", "no", any case, surrounding whitespace ok)
 *   - `empty` — empty / whitespace-only input. Caller decides default.
 *   - `unrecognized` — anything else.
 *
 * Pure: no I/O, no side effects. Re-used by `askConfirm` and
 * available for callers that already collected an answer
 * elsewhere.
 */
export function parseYesNo(answer: string): YesNoToken {
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "") return "empty";
  if (YES_WORDS.has(trimmed)) return "yes";
  if (NO_WORDS.has(trimmed)) return "no";
  return "unrecognized";
}

/**
 * Ask a yes/no question with re-prompts on unrecognized input.
 *
 * @param promptFn   Wraps interaction with stdin. Tests inject a
 *                   scripted queue; production wires this to the
 *                   `prompt()` helper from `prompt.ts`.
 * @param message    The question text without the `[Y/n]` suffix —
 *                   this function renders the suffix based on
 *                   `defaultYes` so all callers stay visually
 *                   consistent.
 * @param defaultYes The answer used when the user just hits Enter,
 *                   AND the fallback if the user keeps typing
 *                   unrecognized text past the retry cap.
 * @param log        Optional sink for the "please answer yes or no"
 *                   hint. Defaults to a no-op so tests don't have
 *                   to mock stdout when they don't care.
 *
 * Returns true for affirmative, false for negative, never throws on
 * recognised inputs. After `MAX_UNRECOGNIZED_RETRIES` non-y/n
 * replies it returns `defaultYes`.
 */
export async function askConfirm(
  promptFn: (opts: PromptOptions) => Promise<string>,
  message: string,
  defaultYes: boolean,
  log: (line: string) => void = () => {},
): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const fullMessage = `${message} ${suffix}`;
  const defaultLetter = defaultYes ? "Y" : "N";
  const defaultWord = defaultYes ? "yes" : "no";

  for (let attempt = 0; attempt < MAX_UNRECOGNIZED_RETRIES; attempt++) {
    const answer = await promptFn({
      message: fullMessage,
      default: defaultLetter,
    });
    const token = parseYesNo(answer);
    switch (token) {
      case "yes":
        return true;
      case "no":
        return false;
      case "empty":
        return defaultYes;
      case "unrecognized":
        log(
          `    Please answer yes or no (or press enter for ${defaultWord}).`,
        );
        continue;
    }
  }
  // Cap reached — return the default so the orchestration above
  // doesn't get stuck. The user has seen the hint
  // MAX_UNRECOGNIZED_RETRIES times by now; the most likely cause is
  // a non-interactive stdin, where falling through is the right move.
  return defaultYes;
}
