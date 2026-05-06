// `klio update` top-level routing + curator-block tests.
//
// E1 wires the subcommand into the CLI dispatch and provides a
// menu picker that selects between curator / agents / provider
// blocks. E2 fleshes out the curator block (re-prompts schedule +
// model, persists to ~/.klio/.env, restarts the engine). The
// agents / provider blocks are still stubs; their tests arrive
// in E3 / E4.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { parseEnvFile } from "../src/envFile.js";
import { runUpdate, parseUpdateTarget } from "../src/commands/update.js";


test("parseUpdateTarget recognises the three direct subcommands", () => {
  assert.equal(parseUpdateTarget(["curator"]), "curator");
  assert.equal(parseUpdateTarget(["agents"]), "agents");
  assert.equal(parseUpdateTarget(["provider"]), "provider");
});

test("parseUpdateTarget returns 'menu' when no subcommand is given", () => {
  assert.equal(parseUpdateTarget([]), "menu");
});

test("parseUpdateTarget rejects unknown targets with 'unknown'", () => {
  assert.equal(parseUpdateTarget(["foo"]), "unknown");
  assert.equal(parseUpdateTarget(["DELETE"]), "unknown");
});


// --- Helpers for the curator-block test ---------------------------


function tmpEnvFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "klio-updatetest-"));
  const path = join(dir, ".env");
  writeFileSync(path, content);
  return path;
}


/**
 * Build a paired (stdin, stdout) the curator-update flow can drive
 * across MULTIPLE `prompt()` calls.
 *
 * The challenge: each `prompt()` creates a fresh LineReader that
 * subscribes to stdin's `data` events. If we push the whole script
 * up front, the first reader receives every line and stashes them
 * in its local queue — but it's disposed at end-of-prompt, taking
 * the un-consumed queue with it. Subsequent prompts get nothing.
 *
 * The fix: push input lazily, one line at a time, in response to
 * the prompt cursor `› ` showing up in stdout. Each prompt receives
 * exactly the line it needs, and no leftover queue is stranded in
 * a disposed reader. The `lines` array holds the script; we shift
 * one off per cursor render.
 */
function captureStreams(scriptLines: readonly string[]) {
  const remaining = [...scriptLines];

  const stdin = new Readable({
    read() {
      // Pull-driven: nothing here. Data is pushed by the stdout
      // hook below as each prompt cursor appears.
    },
  });
  // Pre-bind a no-op error handler so `Readable` doesn't complain
  // about an absent listener if anything errors during the test.
  stdin.on("error", () => {});

  const chunks: string[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      const text = chunk.toString();
      chunks.push(text);
      // The prompt module renders `<message> [default] › ` to
      // stdout each time it asks for a line. We treat that suffix
      // as the trigger to release the next scripted line.
      if (text.endsWith("› ") && remaining.length > 0) {
        const line = remaining.shift() as string;
        // Push on the next tick so the reader's `data` handler is
        // already attached (prompt sets it up before rendering).
        queueMicrotask(() => stdin.push(line + "\n"));
      }
      cb();
    },
  });

  return { stdin, stdout, chunks };
}


// --- Curator-block tests ------------------------------------------


test("runUpdate curator persists a non-default cadence + extraction-model fallback", async () => {
  // Seed a .env that mirrors what `klio init` would write —
  // includes unrelated keys (JWT, OpenRouter creds) that must
  // survive the curator update untouched.
  const envPath = tmpEnvFile(
    [
      "KLIO_JWT_SIGNING_KEY=sentinel-jwt",
      "KLIO_OPENROUTER_API_KEY=sk-or-sentinel",
      "KLIO_LOCAL_USER_ID=00000000-0000-0000-0000-000000000001",
      "KLIO_CURATOR_ENABLED=true",
      "KLIO_CURATOR_INTERVAL_SECS=3600",
      "KLIO_CURATOR_MODEL=",
      "",
    ].join("\n"),
  );

  // Inputs: schedule = 3 (daily), model = 1 (extraction fallback).
  // Trailing empty line is harmless — the prompt only consumes two.
  const { stdin, stdout } = captureStreams(["3", "1"]);

  let restartCalls = 0;
  await runUpdate({
    args: ["curator"],
    envPath,
    stdin,
    stdout,
    restartEngine: async () => {
      restartCalls += 1;
    },
  });

  const after = parseEnvFile(envPath);
  // Curator block updated:
  assert.equal(after.KLIO_CURATOR_ENABLED, "true");
  assert.equal(after.KLIO_CURATOR_INTERVAL_SECS, "86400");
  assert.equal(after.KLIO_CURATOR_MODEL, "");
  // Unrelated keys preserved:
  assert.equal(after.KLIO_JWT_SIGNING_KEY, "sentinel-jwt");
  assert.equal(after.KLIO_OPENROUTER_API_KEY, "sk-or-sentinel");
  assert.equal(
    after.KLIO_LOCAL_USER_ID,
    "00000000-0000-0000-0000-000000000001",
  );
  // Engine restart attempted exactly once:
  assert.equal(restartCalls, 1);
});


test("runUpdate curator with 'disable' flips KLIO_CURATOR_ENABLED to false", async () => {
  const envPath = tmpEnvFile(
    "KLIO_CURATOR_ENABLED=true\nKLIO_CURATOR_INTERVAL_SECS=3600\nKLIO_CURATOR_MODEL=\n",
  );

  // Schedule = 5 (disable), model = 1 (extraction fallback).
  const { stdin, stdout } = captureStreams(["5", "1"]);

  await runUpdate({
    args: ["curator"],
    envPath,
    stdin,
    stdout,
    restartEngine: async () => {},
  });

  const after = parseEnvFile(envPath);
  assert.equal(after.KLIO_CURATOR_ENABLED, "false");
});


test("runUpdate curator with custom model writes the typed string", async () => {
  const envPath = tmpEnvFile(
    "KLIO_CURATOR_ENABLED=true\nKLIO_CURATOR_INTERVAL_SECS=3600\nKLIO_CURATOR_MODEL=\n",
  );

  // Schedule = 1 (hourly, current default), model = 2 (custom),
  // then a free-form value.
  const { stdin, stdout } = captureStreams([
    "1",
    "2",
    "openrouter/anthropic/claude-3-5-sonnet",
  ]);

  await runUpdate({
    args: ["curator"],
    envPath,
    stdin,
    stdout,
    restartEngine: async () => {},
  });

  const after = parseEnvFile(envPath);
  assert.equal(
    after.KLIO_CURATOR_MODEL,
    "openrouter/anthropic/claude-3-5-sonnet",
  );
  assert.equal(after.KLIO_CURATOR_INTERVAL_SECS, "3600");
});
