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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { parseEnvFile } from "../src/envFile.js";
import { runUpdate, parseUpdateTarget } from "../src/commands/update.js";


type TestCtx = { after: (fn: () => void) => void };

/**
 * Redirect HOME (POSIX), USERPROFILE (Windows-via-os.homedir),
 * APPDATA, and XDG_CONFIG_HOME to a fresh tmpdir so every adapter's
 * `installed()` check resolves to false on this test process. Lets
 * us drive the "no agents detected" branch of `runUpdateAgents`
 * deterministically without relying on what's installed on the
 * developer's machine.
 */
function withFakeHome(t: TestCtx): string {
  const home = mkdtempSync(join(tmpdir(), "klio-updateagents-test-"));
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = home;
  process.env.XDG_CONFIG_HOME = home;
  t.after(() => {
    process.env.HOME = prev.HOME;
    process.env.USERPROFILE = prev.USERPROFILE;
    process.env.APPDATA = prev.APPDATA;
    process.env.XDG_CONFIG_HOME = prev.XDG_CONFIG_HOME;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return home;
}


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


// --- Agents-block tests -------------------------------------------


/**
 * Capture stdout into an array of chunks for prefix/substring
 * assertions. No prompt automation here — when no adapters are
 * detected, `wireDetectedAgents` returns before reading stdin, so
 * we don't need the cursor-driven script harness from the curator
 * tests.
 */
function captureStdout(): { stdout: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stdout, chunks };
}


test(
  "runUpdate agents prints the re-detection prologue (regression: not the stub)",
  async (t) => {
    // The most important guarantee for E3: the stub message
    // "klio update agents: not yet implemented" no longer ships.
    // Anyone reverting `runUpdateAgents` to the stub flunks this
    // test immediately. We don't fake adapters here — even on a
    // host with adapters installed, the prologue prints first.
    withFakeHome(t);

    const { stdout, chunks } = captureStdout();
    // Empty stdin: if the test host happens to have an adapter,
    // the confirm prompt's `askConfirm` will burn through five
    // unrecognized retries and fall back to defaultYes. With our
    // fake HOME no adapters are detected, so the prompt is never
    // reached.
    const stdin = new Readable({ read() {} });
    stdin.push(null);

    await runUpdate({
      args: ["agents"],
      stdin,
      stdout,
    });

    const out = chunks.join("");
    assert.ok(
      out.includes("Re-detecting AI agents and re-wiring MCP configs"),
      `expected the agents prologue, got:\n${out}`,
    );
    assert.ok(
      !out.includes("not yet implemented"),
      `runUpdateAgents must no longer print the v0.4.x stub:\n${out}`,
    );
  },
);


test(
  "runUpdate agents on an empty host prints the install hint and exits cleanly",
  async (t) => {
    // No adapters detected ⇒ shared helper returns
    // `{ skipped: true, configured: [], errored: [] }`. The agents
    // block should render the "Install ... and re-run" copy rather
    // than the "Skipped — re-run" copy (which only fires when the
    // user declined a confirm — unreachable when there's nothing
    // to confirm).
    withFakeHome(t);

    const { stdout, chunks } = captureStdout();
    const stdin = new Readable({ read() {} });
    stdin.push(null);

    await runUpdate({
      args: ["agents"],
      stdin,
      stdout,
    });

    const out = chunks.join("");
    assert.ok(
      out.includes("No supported AI agents detected"),
      `expected the install hint on an empty host, got:\n${out}`,
    );
    assert.ok(
      !out.includes("Skipped"),
      `the empty-host branch must not print the declined-confirm copy:\n${out}`,
    );
  },
);
