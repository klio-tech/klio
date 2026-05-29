// Unit tests for the passive-capture hook client (src/commands/hook.ts).
// Every seam (config, stdin, fetch, git, transcript reader) is injected so
// the suite never touches the network, the real filesystem (except one
// temp-file transcript-parse test), git, or process stdin.

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CloudConfig } from "../src/cloudConfig.js";
import { runHook } from "../src/commands/hook.js";

const CONFIG: CloudConfig = {
  apiKey: "ag_live_k",
  agentId: "klio-test",
  baseUrl: "https://brain.test",
};

type Call = { url: string; init: RequestInit };

function makeFetch(
  handler: (url: string) => Response = () =>
    new Response(JSON.stringify({ memories: [], count: 0 }), { status: 200 }),
): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input));
  }) as typeof fetch;
  return { fn, calls };
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

// --- gating -----------------------------------------------------------

test("no cloud config → silent no-op, no network", async () => {
  const { fn, calls } = makeFetch();
  const code = await runHook("SessionStart", {
    config: null,
    stdin: "{}",
    fetchFn: fn,
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
});

test("unknown event → no-op", async () => {
  const { fn, calls } = makeFetch();
  const code = await runHook("PreToolUse", {
    config: CONFIG,
    stdin: "{}",
    fetchFn: fn,
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
});

// --- SessionStart -----------------------------------------------------

test("SessionStart posts recall and prints additionalContext", async () => {
  const { fn, calls } = makeFetch(
    () =>
      new Response(
        JSON.stringify({
          memories: [{ memory_type: "fact", content: "we use pnpm" }],
          count: 1,
        }),
        { status: 200 },
      ),
  );
  const lines: string[] = [];
  const code = await runHook("SessionStart", {
    config: CONFIG,
    stdin: JSON.stringify({ cwd: "/x" }),
    fetchFn: fn,
    stdout: (l) => lines.push(l),
    gitRemoteFn: () => null,
  });

  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://brain.test/capture/recall");

  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("X-Vex-Key"), "ag_live_k");
  assert.equal(headers.get("X-Vex-Agent"), "klio-test/claude-code");

  const body = bodyOf(calls[0]);
  assert.equal(body.query, "");
  assert.equal(body.repo_root, "/x");

  const out = JSON.parse(lines.join("")) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /## Klio context/);
  assert.match(out.hookSpecificOutput.additionalContext, /\[fact\] we use pnpm/);
});

test("SessionStart with no memories prints nothing", async () => {
  const { fn } = makeFetch(
    () => new Response(JSON.stringify({ memories: [], count: 0 }), { status: 200 }),
  );
  const lines: string[] = [];
  await runHook("SessionStart", {
    config: CONFIG,
    stdin: "{}",
    fetchFn: fn,
    stdout: (l) => lines.push(l),
  });
  assert.equal(lines.length, 0);
});

test("SessionStart tolerates a network failure (exit 0, no output)", async () => {
  const fn = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const lines: string[] = [];
  const code = await runHook("SessionStart", {
    config: CONFIG,
    stdin: "{}",
    fetchFn: fn,
    stdout: (l) => lines.push(l),
  });
  assert.equal(code, 0);
  assert.equal(lines.length, 0);
});

test("SessionStart includes git_remote when the cwd is a repo", async () => {
  const { fn, calls } = makeFetch();
  await runHook("SessionStart", {
    config: CONFIG,
    stdin: JSON.stringify({ cwd: "/repo" }),
    fetchFn: fn,
    gitRemoteFn: () => "git@github.com:o/r.git",
  });
  const body = bodyOf(calls[0]);
  assert.equal(body.git_remote, "git@github.com:o/r.git");
  assert.equal(body.repo_root, "/repo");
});

// --- UserPromptSubmit -------------------------------------------------

test("UserPromptSubmit captures a 'remember that' trigger as a memory", async () => {
  const { fn, calls } = makeFetch();
  await runHook("UserPromptSubmit", {
    config: CONFIG,
    stdin: JSON.stringify({ prompt: "Remember that we use pnpm.", session_id: "s1" }),
    fetchFn: fn,
    gitRemoteFn: () => null,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://brain.test/capture/event");
  const body = bodyOf(calls[0]);
  assert.equal(body.content, "we use pnpm");
  assert.equal(body.memory_type, "memory");
  assert.equal(body.session_id, "s1");
});

test("UserPromptSubmit ignores a non-trigger prompt", async () => {
  const { fn, calls } = makeFetch();
  await runHook("UserPromptSubmit", {
    config: CONFIG,
    stdin: JSON.stringify({ prompt: "what does this function do?" }),
    fetchFn: fn,
  });
  assert.equal(calls.length, 0);
});

test("UserPromptSubmit matches the 'note that' trigger", async () => {
  const { fn, calls } = makeFetch();
  await runHook("UserPromptSubmit", {
    config: CONFIG,
    stdin: JSON.stringify({ prompt: "note that the API base is /v2" }),
    fetchFn: fn,
  });
  assert.equal(bodyOf(calls[0]).content, "the API base is /v2");
});

// --- Stop -------------------------------------------------------------

test("Stop forwards transcript messages to /capture/transcript", async () => {
  const { fn, calls } = makeFetch();
  await runHook("Stop", {
    config: CONFIG,
    stdin: JSON.stringify({ transcript_path: "/t.jsonl", session_id: "s2" }),
    fetchFn: fn,
    readTranscriptFn: () => [{ role: "user", content: "hi" }],
    gitRemoteFn: () => null,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://brain.test/capture/transcript");
  const body = bodyOf(calls[0]);
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
  assert.equal(body.session_id, "s2");
});

test("Stop with no transcript_path is a no-op", async () => {
  const { fn, calls } = makeFetch();
  await runHook("Stop", { config: CONFIG, stdin: "{}", fetchFn: fn });
  assert.equal(calls.length, 0);
});

test("Stop with an empty transcript is a no-op", async () => {
  const { fn, calls } = makeFetch();
  await runHook("Stop", {
    config: CONFIG,
    stdin: JSON.stringify({ transcript_path: "/t.jsonl" }),
    fetchFn: fn,
    readTranscriptFn: () => [],
  });
  assert.equal(calls.length, 0);
});

test("Stop parses a real JSONL transcript (nested message, block array)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "klio-tx-"));
  try {
    const path = join(dir, "t.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
        }),
        JSON.stringify({ type: "system", content: "ignored" }),
        "not json",
      ].join("\n"),
      "utf8",
    );

    const { fn, calls } = makeFetch();
    await runHook("Stop", {
      config: CONFIG,
      stdin: JSON.stringify({ transcript_path: path }),
      fetchFn: fn,
      gitRemoteFn: () => null,
    });

    const body = bodyOf(calls[0]);
    assert.deepEqual(body.messages, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- robustness -------------------------------------------------------

test("malformed stdin does not crash (SessionStart still runs)", async () => {
  const { fn, calls } = makeFetch();
  const code = await runHook("SessionStart", {
    config: CONFIG,
    stdin: "{not json",
    fetchFn: fn,
    gitRemoteFn: () => null,
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1); // empty payload → recall with no project
});

test("event normalization accepts the local bridge subcommand name", async () => {
  const { fn, calls } = makeFetch();
  await runHook("session-start", {
    config: CONFIG,
    stdin: "{}",
    fetchFn: fn,
  });
  assert.equal(calls[0].url, "https://brain.test/capture/recall");
});
