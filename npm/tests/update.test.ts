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


// --- Curator --run-now flag tests ---------------------------------
//
// E5 wires the `--run-now` flag onto `klio update curator`. After
// the env file is rewritten and the engine is re-created, the flag
// asks the bridge container to invoke `POST /v1/curator/run-now`
// against the engine on the user's behalf. The bridge already holds
// the user's bearer token; the npm CLI does not. So the contract is:
// `docker exec klio-bridge klio curator run-now`. The bridge gains
// that subcommand in a follow-up task; the npm side is written
// against the contract and degrades gracefully if the bridge is too
// old to recognise the subcommand.


test("runUpdate curator with --run-now triggers the bridge run-now invocation", async () => {
  const envPath = tmpEnvFile(
    "KLIO_CURATOR_ENABLED=true\nKLIO_CURATOR_INTERVAL_SECS=3600\nKLIO_CURATOR_MODEL=\n",
  );

  // Schedule = 1 (hourly), model = 1 (extraction fallback).
  const { stdin, stdout } = captureStreams(["1", "1"]);

  const restartOrder: string[] = [];
  const runNowCalls: string[][] = [];

  await runUpdate({
    args: ["curator", "--run-now"],
    envPath,
    stdin,
    stdout,
    restartEngine: async () => {
      restartOrder.push("restart");
    },
    runNowExec: async (argv) => {
      restartOrder.push("run-now");
      runNowCalls.push([...argv]);
      return { exitCode: 0, stdout: '{"runs_count":1,"facts_synthesized":4}\n', stderr: "" };
    },
  });

  // The flag fires the run-now exec exactly once, AFTER the restart.
  assert.equal(runNowCalls.length, 1);
  assert.deepEqual(restartOrder, ["restart", "run-now"]);
  // The argv we pass to the exec helper must target the bridge
  // container with the `klio curator run-now` subcommand contract.
  // We don't pin the exact argv shape (the helper owns the docker
  // exec wrapping) but we assert the intent: container + subcommand.
  const argv = runNowCalls[0];
  assert.ok(
    argv.includes("klio-bridge"),
    `expected the bridge container in argv, got: ${JSON.stringify(argv)}`,
  );
  assert.ok(
    argv.includes("curator") && argv.includes("run-now"),
    `expected the curator run-now subcommand in argv, got: ${JSON.stringify(argv)}`,
  );
});


test("runUpdate curator without --run-now does NOT invoke the bridge", async () => {
  const envPath = tmpEnvFile(
    "KLIO_CURATOR_ENABLED=true\nKLIO_CURATOR_INTERVAL_SECS=3600\nKLIO_CURATOR_MODEL=\n",
  );

  // Schedule = 1, model = 1 — same shape as the --run-now test, but
  // we omit the flag from argv. The run-now hook MUST stay untouched.
  const { stdin, stdout } = captureStreams(["1", "1"]);

  let runNowCalls = 0;
  await runUpdate({
    args: ["curator"],
    envPath,
    stdin,
    stdout,
    restartEngine: async () => {},
    runNowExec: async () => {
      runNowCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(
    runNowCalls,
    0,
    "the run-now hook must only fire when --run-now is in argv",
  );
});


test(
  "runUpdate curator --run-now reports a friendly message when the bridge is too old",
  async () => {
    // Simulates `docker exec klio-bridge klio curator run-now`
    // failing because the bridge binary doesn't yet recognise the
    // subcommand. The npm CLI must NOT throw — env was already
    // saved, the engine was already re-created, and the user's
    // settings change has fully landed. The run-now is a best-effort
    // convenience; failure here is logged, not fatal.
    const envPath = tmpEnvFile(
      "KLIO_CURATOR_ENABLED=true\nKLIO_CURATOR_INTERVAL_SECS=3600\nKLIO_CURATOR_MODEL=\n",
    );

    const { stdin, stdout, chunks } = captureStreams(["1", "1"]);

    let runNowCalls = 0;
    // Intentionally non-zero exit + a stderr that mimics the bridge
    // CLI's "unknown subcommand" copy.
    await runUpdate({
      args: ["curator", "--run-now"],
      envPath,
      stdin,
      stdout,
      restartEngine: async () => {},
      runNowExec: async () => {
        runNowCalls += 1;
        return {
          exitCode: 2,
          stdout: "",
          stderr: "unknown subcommand: curator\n",
        };
      },
    });

    assert.equal(runNowCalls, 1);
    const out = chunks.join("");
    // The user must see a clear message; the env file save still happened.
    assert.ok(
      out.includes("run-now") || out.includes("Run-now"),
      `expected a run-now status line in stdout, got:\n${out}`,
    );
  },
);


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


// --- Provider-block tests -----------------------------------------


test(
  "runUpdate provider prints the re-run prologue (regression: not the stub)",
  async () => {
    // The most important guarantee for E4: the stub message
    // "klio update provider: not yet implemented" no longer ships.
    // Anyone reverting `runUpdateProvider` to the stub flunks this
    // test immediately. We don't drive the picker here — the
    // prologue prints BEFORE any prompt, so we can interrupt the
    // flow at the first prompt by ending stdin (which causes the
    // injected provider hook to throw a recognizable error we
    // ignore in this regression assertion).
    const envPath = tmpEnvFile(
      [
        "KLIO_JWT_SIGNING_KEY=sentinel-jwt",
        "KLIO_OPENROUTER_API_KEY=sk-or-existing",
        "",
      ].join("\n"),
    );

    const { stdout, chunks } = captureStdout();
    const stdin = new Readable({ read() {} });
    stdin.push(null);

    let restartCalls = 0;
    try {
      await runUpdate({
        args: ["provider"],
        envPath,
        stdin,
        stdout,
        // Inject a stub that simulates the user cancelling at the
        // very first menu — the prologue must already have printed
        // by the time our hook is invoked.
        runProviderStep: async () => {
          throw new Error("test-cancel");
        },
        restartEngine: async () => {
          restartCalls += 1;
        },
      });
    } catch (err) {
      // Swallow the synthetic cancellation — this test only cares
      // about the prologue copy, not the full happy path.
      assert.equal((err as Error).message, "test-cancel");
    }

    const out = chunks.join("");
    assert.ok(
      out.includes("Re-running provider setup"),
      `expected the provider prologue, got:\n${out}`,
    );
    assert.ok(
      !out.includes("not yet implemented"),
      `runUpdateProvider must no longer print the v0.4.x stub:\n${out}`,
    );
    // Restart must NOT fire when the picker bails — the env wasn't
    // rewritten, so a restart would only churn the engine for nothing.
    assert.equal(restartCalls, 0);
  },
);


test(
  "runUpdate provider persists openrouter env vars and clears stale custom keys",
  async () => {
    // Seed a .env that LOOKS like a prior `klio init` left a custom
    // endpoint configured. The provider re-run should overwrite the
    // openrouter slot AND blank the now-stale custom slot so the
    // engine doesn't keep dispatching custom requests.
    const envPath = tmpEnvFile(
      [
        "KLIO_JWT_SIGNING_KEY=sentinel-jwt",
        "KLIO_LOCAL_USER_ID=00000000-0000-0000-0000-000000000001",
        "KLIO_OPENROUTER_API_KEY=",
        "KLIO_CUSTOM_BASE_URL=https://stale.example.com/v1",
        "KLIO_CUSTOM_API_KEY=stale-key",
        "KLIO_EMBEDDING_MODEL=custom/old-embed",
        "KLIO_EXTRACTION_MODEL=custom/old-chat",
        "KLIO_EMBEDDING_DIM=512",
        "",
      ].join("\n"),
    );

    const { stdout } = captureStdout();
    const stdin = new Readable({ read() {} });
    stdin.push(null);

    let restartCalls = 0;
    await runUpdate({
      args: ["provider"],
      envPath,
      stdin,
      stdout,
      runProviderStep: async () => ({
        kind: "openrouter",
        config: {
          openrouterKey: "sk-or-new",
          embeddingModel: "openai/text-embedding-3-small",
          embeddingDim: 1536,
          extractionModel: "anthropic/claude-3-5-haiku",
          totalTestTokens: 42,
        },
      }),
      restartEngine: async () => {
        restartCalls += 1;
      },
    });

    const after = parseEnvFile(envPath);
    // OpenRouter slot populated:
    assert.equal(after.KLIO_OPENROUTER_API_KEY, "sk-or-new");
    assert.equal(
      after.KLIO_EMBEDDING_MODEL,
      "openrouter/openai/text-embedding-3-small",
    );
    assert.equal(
      after.KLIO_EXTRACTION_MODEL,
      "openrouter/anthropic/claude-3-5-haiku",
    );
    assert.equal(after.KLIO_EMBEDDING_DIM, "1536");
    // Stale custom-endpoint creds blanked:
    assert.equal(after.KLIO_CUSTOM_BASE_URL, "");
    assert.equal(after.KLIO_CUSTOM_API_KEY, "");
    // Unrelated keys preserved:
    assert.equal(after.KLIO_JWT_SIGNING_KEY, "sentinel-jwt");
    assert.equal(
      after.KLIO_LOCAL_USER_ID,
      "00000000-0000-0000-0000-000000000001",
    );
    assert.equal(restartCalls, 1);
  },
);


test(
  "runUpdate provider persists ollama env vars and clears upstream keys",
  async () => {
    // Switching from openrouter → ollama must blank
    // KLIO_OPENROUTER_API_KEY so the engine can't keep using a
    // stale cloud key. Embedding model loses its tag (registry
    // resolution); extraction model keeps its tag (chat dispatch
    // depends on it).
    const envPath = tmpEnvFile(
      [
        "KLIO_OPENROUTER_API_KEY=sk-or-stale",
        "KLIO_CUSTOM_BASE_URL=",
        "KLIO_CUSTOM_API_KEY=",
        "KLIO_EMBEDDING_MODEL=openrouter/openai/text-embedding-3-small",
        "KLIO_EXTRACTION_MODEL=openrouter/anthropic/claude-3-5-haiku",
        "KLIO_EMBEDDING_DIM=1536",
        "",
      ].join("\n"),
    );

    const { stdout } = captureStdout();
    const stdin = new Readable({ read() {} });
    stdin.push(null);

    await runUpdate({
      args: ["provider"],
      envPath,
      stdin,
      stdout,
      runProviderStep: async () => ({
        kind: "ollama",
        config: {
          kind: "ollama",
          embeddingModel: "nomic-embed-text:latest",
          embeddingDim: 768,
          extractionModel: "qwen2.5:7b-instruct",
        },
      }),
      restartEngine: async () => {},
    });

    const after = parseEnvFile(envPath);
    // Stale cloud key blanked:
    assert.equal(after.KLIO_OPENROUTER_API_KEY, "");
    // Embedding bare (tag stripped):
    assert.equal(after.KLIO_EMBEDDING_MODEL, "ollama/nomic-embed-text");
    // Extraction keeps its tag:
    assert.equal(
      after.KLIO_EXTRACTION_MODEL,
      "ollama/qwen2.5:7b-instruct",
    );
    assert.equal(after.KLIO_EMBEDDING_DIM, "768");
  },
);


test(
  "runUpdate provider persists custom env vars and clears stale openrouter key",
  async () => {
    const envPath = tmpEnvFile(
      [
        "KLIO_OPENROUTER_API_KEY=sk-or-stale",
        "KLIO_CUSTOM_BASE_URL=",
        "KLIO_CUSTOM_API_KEY=",
        "",
      ].join("\n"),
    );

    const { stdout } = captureStdout();
    const stdin = new Readable({ read() {} });
    stdin.push(null);

    await runUpdate({
      args: ["provider"],
      envPath,
      stdin,
      stdout,
      runProviderStep: async () => ({
        kind: "custom",
        config: {
          kind: "custom",
          baseUrl: "https://litellm.example.com/v1",
          apiKey: "custom-secret",
          embeddingModel: "litellm-embed",
          embeddingDim: 1024,
          extractionModel: "litellm-chat",
        },
      }),
      restartEngine: async () => {},
    });

    const after = parseEnvFile(envPath);
    assert.equal(after.KLIO_OPENROUTER_API_KEY, "");
    assert.equal(
      after.KLIO_CUSTOM_BASE_URL,
      "https://litellm.example.com/v1",
    );
    assert.equal(after.KLIO_CUSTOM_API_KEY, "custom-secret");
    assert.equal(after.KLIO_EMBEDDING_MODEL, "custom/litellm-embed");
    assert.equal(after.KLIO_EXTRACTION_MODEL, "custom/litellm-chat");
    assert.equal(after.KLIO_EMBEDDING_DIM, "1024");
  },
);


// --- v0.6.0: --check / --to-latest / --to-version ----------------
//
// D3 layers three new flags on top of the existing 0.5.0 dispatcher.
// The flags short-circuit the curator/agents/provider menu — they're
// stack-wide upgrade affordances, not per-slice updates.
//
// All three tests inject hook seams (`fetchFn`, `statePath`,
// `composeApply`) so the suite never touches the real npm registry,
// the user's docker daemon, or the user's ~/.klio runtime dir.


/**
 * Build a minimal `fetch`-compatible response for the npm registry's
 * `latest` endpoint. The CLI only reads `.ok`, `.status`, and `.json()`,
 * so we satisfy that surface without pulling in undici's Response class.
 */
function fakeNpmFetch(version: string): typeof fetch {
  const fn = (async (_url: string | URL | Request, _init?: RequestInit) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({ version }),
    } as unknown as Response;
  }) as typeof fetch;
  return fn;
}


function tmpStateFile(currentVersion: string): string {
  const dir = mkdtempSync(join(tmpdir(), "klio-updatestate-"));
  const path = join(dir, "update-state.json");
  writeFileSync(path, JSON.stringify({ current_version: currentVersion }));
  return path;
}


test("runUpdate --check prints current vs latest and a 'newer available' hint", async () => {
  const statePath = tmpStateFile("0.6.0");
  const { stdout, chunks } = captureStdout();

  await runUpdate({
    args: ["--check"],
    stdin: new Readable({ read() {} }),
    stdout,
    statePath,
    fetchFn: fakeNpmFetch("0.6.1"),
  });

  const out = chunks.join("");
  assert.ok(out.includes("0.6.0"), `expected current version in output: ${out}`);
  assert.ok(out.includes("0.6.1"), `expected latest version in output: ${out}`);
  assert.ok(
    out.includes("klio update --to-latest"),
    `expected the apply hint when a newer version is available: ${out}`,
  );
});


test("runUpdate --check reports 'on the latest' when versions match", async () => {
  const statePath = tmpStateFile("0.6.1");
  const { stdout, chunks } = captureStdout();

  await runUpdate({
    args: ["--check"],
    stdin: new Readable({ read() {} }),
    stdout,
    statePath,
    fetchFn: fakeNpmFetch("0.6.1"),
  });

  const out = chunks.join("");
  assert.ok(
    out.includes("latest"),
    `expected the up-to-date message in output: ${out}`,
  );
  assert.ok(
    !out.includes("--to-latest"),
    `must not advertise the apply hint when already current: ${out}`,
  );
});


test(
  "runUpdate --to-version <X> validates X then re-renders compose with the new tag",
  async (t) => {
    // Drive the full --to-version flow into a fake $HOME so we can
    // assert the rendered docker-compose.yml without touching the
    // developer's real runtime dir.
    const home = withFakeHome(t);
    const klioDir = join(home, ".klio");
    // Ensure parent dir exists for the .env we seed below.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(klioDir, { recursive: true, mode: 0o700 });
    const envPath = join(klioDir, ".env");
    writeFileSync(
      envPath,
      "KLIO_JWT_SIGNING_KEY=sentinel-jwt\nKLIO_OPENROUTER_API_KEY=sk-or-existing\n",
    );

    const { stdout } = captureStdout();
    const composeCalls: { args: string[][] } = { args: [] };

    await runUpdate({
      args: ["--to-version", "9.9.9"],
      stdin: new Readable({ read() {} }),
      stdout,
      composeApply: async (args) => {
        composeCalls.args.push([...args]);
      },
    });

    // Compose template was re-rendered with the new tag. Read it
    // back from the runtime dir (which we just redirected to $HOME).
    const { readFileSync } = await import("node:fs");
    const composePath = join(klioDir, "docker-compose.yml");
    const body = readFileSync(composePath, "utf8");
    assert.ok(
      body.includes("klio-engine:9.9.9"),
      `expected the rendered compose to pin engine to 9.9.9, got:\n${body.slice(0, 400)}`,
    );
    assert.ok(
      body.includes("klio-bridge:9.9.9"),
      `expected the rendered compose to pin bridge to 9.9.9: ${body.slice(0, 400)}`,
    );

    // The compose-apply hook fires twice: once for `pull` and once
    // for `up -d --no-deps engine bridge trust-app`.
    assert.equal(composeCalls.args.length, 2, "expected pull + up");
    assert.ok(
      composeCalls.args[0].includes("pull"),
      `first compose call must be pull, got: ${JSON.stringify(composeCalls.args[0])}`,
    );
    const upArgs = composeCalls.args[1];
    assert.ok(upArgs.includes("up") && upArgs.includes("-d"), `expected up -d in second call, got: ${JSON.stringify(upArgs)}`);
    assert.ok(
      upArgs.includes("engine") && upArgs.includes("bridge") && upArgs.includes("trust-app"),
      `expected all three klio services in up call, got: ${JSON.stringify(upArgs)}`,
    );

    // Sanity: the env's existing JWT survived the round-trip
    // (writeComposeFile shouldn't touch the .env, but if a future
    // refactor added a write path, this assertion catches it).
    const after = parseEnvFile(envPath);
    assert.equal(after.KLIO_JWT_SIGNING_KEY, "sentinel-jwt");
    assert.equal(after.KLIO_OPENROUTER_API_KEY, "sk-or-existing");
  },
);


test(
  "runUpdate --to-version with a non-semver argument refuses and never re-renders",
  async (t) => {
    // We use a child process to capture process.exit cleanly.
    // Driving runUpdate directly would kill the test runner because
    // the bad-arg path calls process.exit(2). Instead we fork a tsx
    // subprocess that imports runUpdate and observe its exit code.
    const home = withFakeHome(t);
    const klioDir = join(home, ".klio");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(klioDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(klioDir, ".env"),
      "KLIO_JWT_SIGNING_KEY=sentinel-jwt\n",
    );

    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { dirname: dn } = await import("node:path");
    const here = dn(fileURLToPath(import.meta.url));
    const script = [
      "import { runUpdate } from '../src/commands/update.js';",
      "await runUpdate({",
      "  args: ['--to-version', 'not-a-version; rm -rf /'],",
      "  composeApply: async () => {},",
      "});",
    ].join("\n");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: here, env: { ...process.env, HOME: home }, encoding: "utf8" },
    );

    assert.notEqual(
      result.status,
      0,
      `expected non-zero exit on bogus version, got: ${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes("not a valid semver"),
      `expected a semver validation error on stderr, got: ${result.stderr}`,
    );
  },
);
