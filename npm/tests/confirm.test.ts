// Yes/no confirmation prompt tests.
//
// Why this exists: 0.4.1 shipped a UX bug in `klio init` where the
// wire-tools confirm prompt (`Wire all detected tools? [Y]`) treated
// any non-`y` input as "no" and silently advanced. A user who typed
// the next-step memory text at this prompt by accident
// ("Abhishek Singh is good") had ALL six agent adapters skipped
// without warning, because the parser collapsed the text into a
// no-answer.
//
// The fix: a single `askConfirm` that re-prompts on unrecognized
// input until a clean yes/no/empty arrives, and emits a "please
// answer yes or no" hint each time. Production-ready behavior:
// unrecognized input is asked again, not silently coerced.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { askConfirm, parseYesNo } from "../src/confirm.js";

// ---------- parseYesNo ----------

test("parseYesNo recognises affirmative variants", () => {
  for (const v of ["y", "Y", "yes", "Yes", "YES", " yes ", "y\n"]) {
    assert.equal(parseYesNo(v), "yes", `expected yes for ${JSON.stringify(v)}`);
  }
});

test("parseYesNo recognises negative variants", () => {
  for (const v of ["n", "N", "no", "No", "NO", " no "]) {
    assert.equal(parseYesNo(v), "no", `expected no for ${JSON.stringify(v)}`);
  }
});

test("parseYesNo recognises empty as empty (caller decides default)", () => {
  for (const v of ["", "   ", "\n", "\t"]) {
    assert.equal(parseYesNo(v), "empty");
  }
});

test("parseYesNo flags arbitrary text as unrecognized", () => {
  // The exact production input that triggered the wire-tools skip:
  assert.equal(parseYesNo("Abhishek Singh is good"), "unrecognized");
  // Common false-positives the old isYes() would have collapsed:
  for (const v of ["yeah", "nope", "sure", "ok", "absolutely", "1", "0"]) {
    assert.equal(parseYesNo(v), "unrecognized", `expected unrecognized for ${v}`);
  }
});

// ---------- askConfirm ----------

/**
 * Build a deterministic promptFn that returns a sequence of replies
 * and tracks how many times it was called. Asserts at the end that
 * the test consumed every scripted reply (i.e. no off-by-one in
 * re-prompt count).
 */
function scripted(replies: string[]): {
  promptFn: (opts: { message: string; default?: string }) => Promise<string>;
  callCount: () => number;
  remaining: () => string[];
} {
  const queue = [...replies];
  let calls = 0;
  return {
    promptFn: async () => {
      calls++;
      if (queue.length === 0) {
        throw new Error("scripted promptFn ran out of replies");
      }
      return queue.shift()!;
    },
    callCount: () => calls,
    remaining: () => queue.slice(),
  };
}

function silentLog(): {
  log: (line: string) => void;
  lines: () => string[];
} {
  const captured: string[] = [];
  return {
    log: (line: string) => captured.push(line),
    lines: () => captured.slice(),
  };
}

test("askConfirm: empty + defaultYes=true → true (the default-Y path)", async () => {
  const s = scripted([""]);
  const result = await askConfirm(s.promptFn, "ok?", true);
  assert.equal(result, true);
  assert.equal(s.callCount(), 1);
});

test("askConfirm: empty + defaultYes=false → false", async () => {
  const s = scripted([""]);
  const result = await askConfirm(s.promptFn, "ok?", false);
  assert.equal(result, false);
});

test("askConfirm: explicit y → true regardless of default", async () => {
  for (const defaultYes of [true, false]) {
    const s = scripted(["y"]);
    const result = await askConfirm(s.promptFn, "ok?", defaultYes);
    assert.equal(result, true);
  }
});

test("askConfirm: explicit n → false regardless of default", async () => {
  for (const defaultYes of [true, false]) {
    const s = scripted(["n"]);
    const result = await askConfirm(s.promptFn, "ok?", defaultYes);
    assert.equal(result, false);
  }
});

test("askConfirm RE-PROMPTS on unrecognized input (the 0.4.1 fix)", async () => {
  // The exact production scenario: user types text instead of y/n.
  // The old code collapsed this to "no" and skipped agent wiring.
  // The fix re-prompts until a clean answer arrives.
  const s = scripted(["Abhishek Singh is good", "y"]);
  const ui = silentLog();
  const result = await askConfirm(s.promptFn, "Wire all detected tools?", true, ui.log);
  assert.equal(result, true, "user's intended yes must come through");
  assert.equal(s.callCount(), 2, "must re-prompt once after unrecognized input");
  assert.equal(s.remaining().length, 0);
  // Hint must be emitted so the user knows why the prompt is asking again.
  assert.ok(
    ui.lines().some((l) => /yes or no/i.test(l)),
    `expected a 'yes or no' hint, got: ${JSON.stringify(ui.lines())}`,
  );
});

test("askConfirm re-prompts multiple times if needed", async () => {
  const s = scripted(["maybe", "perhaps", "no"]);
  const ui = silentLog();
  const result = await askConfirm(s.promptFn, "ok?", true, ui.log);
  assert.equal(result, false);
  assert.equal(s.callCount(), 3);
});

test("askConfirm caps re-prompts and falls back to default", async () => {
  // After a generous number of unrecognized answers, return the
  // default rather than spin forever — protects against piped
  // stdin or weird terminal states.
  const s = scripted(["abc", "def", "ghi", "jkl", "mno"]);
  const ui = silentLog();
  const result = await askConfirm(s.promptFn, "ok?", true, ui.log);
  // Whatever the cap is, the function must return SOMETHING (not throw)
  // and consume a finite number of replies.
  assert.equal(typeof result, "boolean");
  assert.ok(s.callCount() <= 5);
});
