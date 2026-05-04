// Tests for the per-step narration helpers in ui.ts.
//
// `narrate` and `phaseRecap` are silenced when `setQuiet(true)` is
// active so re-runs by experienced users skip the explanatory text;
// `phaseHeader` always renders because it's the structural marker
// that orients the user across a multi-phase flow.
//
// Each test resets `setQuiet(false)` at the end so we don't leak
// quiet-mode state into other tests in the suite.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { narrate, phaseHeader, phaseRecap, setQuiet } from "../src/ui.js";

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((c: any) => {
    chunks.push(c.toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

test("narrate writes indented context line by default", () => {
  setQuiet(false);
  const out = captureStdout(() => narrate("hello"));
  assert.match(out, /\s{8}hello\n/);
});

test("narrate is a no-op when quiet=true", () => {
  setQuiet(true);
  const out = captureStdout(() => narrate("hidden"));
  assert.equal(out, "");
  setQuiet(false);
});

test("phaseHeader writes a Phase N / 5 banner", () => {
  setQuiet(false);
  const out = captureStdout(() => phaseHeader(3, 5, "Bring up your stack"));
  assert.match(out, /Phase 3 \/ 5/);
  assert.match(out, /Bring up your stack/);
});

test("phaseHeader still prints when quiet=true", () => {
  setQuiet(true);
  const out = captureStdout(() => phaseHeader(2, 5, "x"));
  assert.match(out, /Phase 2 \/ 5/);
  setQuiet(false);
});

test("phaseRecap suppressed when quiet=true", () => {
  setQuiet(true);
  const out = captureStdout(() => phaseRecap("Phase 3 done — engine running."));
  assert.equal(out, "");
  setQuiet(false);
});

test("phaseRecap visible when quiet=false", () => {
  setQuiet(false);
  const out = captureStdout(() => phaseRecap("Phase 3 done."));
  assert.match(out, /Phase 3 done/);
});
