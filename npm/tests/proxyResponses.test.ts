// The OpenAI Responses API path — Codex's shape.
//
// Every fixture in here is derived from a REAL Codex request recorded
// off the wire (codex-cli 0.39.0, `wire_api = "responses"`): top-level
// keys `model`, `instructions`, `input`, `tools`, `tool_choice`,
// `parallel_tool_calls`, `reasoning`, `store`, `stream`, `include`,
// `prompt_cache_key`; `instructions` a single ~24 KB string; `input` an
// array of `message` / `function_call` / `function_call_output` items,
// with message content as `[{ type: "input_text", text }]`.
//
// The properties asserted are the same ones the Messages path is held
// to, because they are the ones that cost real money when they break:
// exactly ONE field is touched, everything else survives BYTE for BYTE,
// and any doubt forwards the original bytes.

import { strict as assert } from "node:assert";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { emitCapture } from "../src/proxy/capture.js";
import { injectMemoriesResponses } from "../src/proxy/inject.js";
import {
  extractResponsesAssistantText,
  lastUserInputText,
  responsesTurns,
} from "../src/proxy/responsesShape.js";
import { createProxyServer } from "../src/proxy/server.js";

const CONFIG = { apiKey: "k", agentId: "a", baseUrl: "https://api.example" };

const MEMS = [
  { id: "m1", content: "Deploys go to Railway from GitHub source." },
  { id: "m2", content: "Health check is /healthz, not /health." },
];

/** A compact, byte-stable Codex-shaped body. */
function codexBody(overrides: Record<string, unknown> = {}): Buffer {
  const body = {
    model: "gpt-5-codex",
    instructions: "You are Codex, a coding agent.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "list the files" }],
      },
      {
        type: "function_call",
        name: "shell",
        arguments: '{"command":["bash","-lc","ls"]}',
        call_id: "call_1",
      },
      { type: "function_call_output", call_id: "call_1", output: "a.txt\nb.txt" },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "where do we deploy?" }],
      },
    ],
    tools: [
      {
        type: "function",
        name: "shell",
        description: "run a shell command",
        parameters: { type: "object", properties: { command: { type: "array" } } },
      },
    ],
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: null,
    store: false,
    stream: true,
    include: [],
    prompt_cache_key: "abc",
    ...overrides,
  };
  return Buffer.from(JSON.stringify(body), "utf8");
}

function parse(buf: Buffer): Record<string, unknown> {
  return JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
}

/** Byte-identity of every top-level key except the named one. */
function assertOnlyFieldChanged(before: Buffer, after: Buffer, field: string): void {
  const a = parse(before);
  const b = parse(after);
  assert.deepEqual(Object.keys(b), Object.keys(a), "key set and order must not change");
  for (const key of Object.keys(a)) {
    if (key === field) continue;
    assert.equal(
      JSON.stringify(b[key]),
      JSON.stringify(a[key]),
      `${key} must be byte-identical`,
    );
  }
}

// ---- injection --------------------------------------------------------

test("responses: memories are appended to instructions, original first", () => {
  const body = codexBody();
  const out = injectMemoriesResponses(body, MEMS);

  assert.equal(out.injected, 2);
  const instructions = parse(out.body)["instructions"] as string;
  assert.ok(instructions.startsWith("You are Codex, a coding agent."), "original comes first");
  assert.ok(instructions.includes("Deploys go to Railway from GitHub source."));
  assert.ok(instructions.includes("Health check is /healthz, not /health."));
});

test("responses: nothing but instructions is touched", () => {
  const body = codexBody();
  const out = injectMemoriesResponses(body, MEMS);
  assertOnlyFieldChanged(body, out.body, "instructions");
});

test("responses: an absent instructions field is created, not guessed at", () => {
  const body = Buffer.from(
    JSON.stringify({ model: "m", input: [{ type: "message", role: "user", content: "hi" }] }),
    "utf8",
  );
  const out = injectMemoriesResponses(body, MEMS);
  assert.equal(out.injected, 2);
  assert.ok(String(parse(out.body)["instructions"]).includes("Railway"));
  assert.equal(JSON.stringify(parse(out.body)["input"]), JSON.stringify(parse(body)["input"]));
});

test("responses: a non-string instructions shape is forwarded unchanged", () => {
  for (const value of [[{ type: "text", text: "x" }], 42, null, { a: 1 }]) {
    const body = codexBody({ instructions: value });
    const out = injectMemoriesResponses(body, MEMS);
    assert.equal(out.injected, 0);
    assert.ok(out.body.equals(body), `instructions=${JSON.stringify(value)} must pass through`);
  }
});

test("responses: injection is idempotent — a retried request is not double-injected", () => {
  const body = codexBody();
  const once = injectMemoriesResponses(body, MEMS);
  const twice = injectMemoriesResponses(once.body, MEMS);
  assert.equal(twice.injected, 0);
  assert.ok(twice.body.equals(once.body));
});

test("responses: a non-byte-stable (pretty-printed) body is forwarded unchanged", () => {
  const pretty = Buffer.from(JSON.stringify(parse(codexBody()), null, 2), "utf8");
  const out = injectMemoriesResponses(pretty, MEMS);
  assert.equal(out.injected, 0);
  assert.ok(out.body.equals(pretty));
});

test("responses: non-JSON and empty memory sets are forwarded unchanged", () => {
  const junk = Buffer.from("not json at all", "utf8");
  assert.equal(injectMemoriesResponses(junk, MEMS).injected, 0);
  assert.ok(injectMemoriesResponses(junk, MEMS).body.equals(junk));

  const body = codexBody();
  assert.equal(injectMemoriesResponses(body, []).injected, 0);
  assert.ok(injectMemoriesResponses(body, []).body.equals(body));
});

// ---- query derivation -------------------------------------------------

test("responses: the query is the last user item that actually carries text", () => {
  assert.equal(lastUserInputText(parse(codexBody())), "where do we deploy?");
});

test("responses: a tool-output-only tail falls back to the last user text", () => {
  const body = codexBody({
    input: [
      ...(parse(codexBody())["input"] as unknown[]),
      { type: "function_call", name: "shell", arguments: "{}", call_id: "c2" },
      { type: "function_call_output", call_id: "c2", output: "done" },
    ],
  });
  assert.equal(lastUserInputText(parse(body)), "where do we deploy?");
});

test("responses: a bare string input is itself the query", () => {
  assert.equal(lastUserInputText({ input: "just this" }), "just this");
});

test("responses: a conversation with no user text yields no query", () => {
  assert.equal(lastUserInputText({ input: [{ type: "function_call_output", output: "x" }] }), "");
  assert.equal(lastUserInputText({ model: "m" }), "");
});

// ---- capture normalisation -------------------------------------------

test("responses: input items normalise to attributable turns", () => {
  const turns = responsesTurns(parse(codexBody()));
  assert.deepEqual(
    turns.map((t) => t.role),
    ["user", "assistant", "user", "user"],
  );
  assert.equal(turns[0].content, "list the files");
  assert.ok(turns[1].content.startsWith("[tool_use: shell]"));
  assert.ok(turns[2].content.startsWith("[tool_result]"));
  assert.equal(turns[3].content, "where do we deploy?");
});

test("responses: unrenderable items are dropped, not fabricated into turns", () => {
  const turns = responsesTurns({
    input: [
      { type: "reasoning", id: "r1", summary: [] },
      { type: "some_future_item", payload: 1 },
      "a bare string",
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ],
  });
  assert.deepEqual(turns.map((t) => t.content), ["hi"]);
});

test("responses: capture posts the conversation to /capture/transcript", async () => {
  const calls: { url: string; body: string }[] = [];
  await emitCapture({
    config: CONFIG,
    agent: "a",
    requestBody: codexBody(),
    assistantText: "We deploy to Railway.",
    shape: "responses",
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init.body) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });

  assert.equal(calls.length, 1, "exactly one capture call");
  assert.equal(calls[0].url, "https://api.example/capture/transcript");
  const payload = JSON.parse(calls[0].body) as {
    session_id: string;
    messages: { role: string; content: string }[];
  };
  assert.match(payload.session_id, /^klio-proxy:a:[0-9a-f]{16}$/);
  assert.equal(payload.messages[0].content, "list the files");
  assert.equal(payload.messages.at(-1)?.content, "We deploy to Railway.");
});

test("responses: the session id is stable across turns of one conversation", async () => {
  const ids: string[] = [];
  const capture = async (body: Buffer): Promise<void> => {
    await emitCapture({
      config: CONFIG,
      agent: "a",
      requestBody: body,
      assistantText: "ok",
      shape: "responses",
      fetchImpl: (async (_u: string, init: RequestInit) => {
        ids.push((JSON.parse(String(init.body)) as { session_id: string }).session_id);
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
  };

  const base = parse(codexBody())["input"] as unknown[];
  await capture(codexBody());
  await capture(
    codexBody({
      input: [
        ...base,
        { type: "function_call", name: "shell", arguments: "{}", call_id: "c9" },
        { type: "function_call_output", call_id: "c9", output: "y" },
      ],
    }),
  );
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1], "the id must not move as the conversation grows");
});

test("responses: a conversation with no assistant turn yet is not captured", async () => {
  let called = 0;
  await emitCapture({
    config: CONFIG,
    agent: "a",
    requestBody: codexBody({
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }),
    assistantText: "",
    shape: "responses",
    fetchImpl: (async () => {
      called += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.equal(called, 0);
});

// ---- assistant text out of a Responses reply --------------------------

test("responses: assistant text is read from a non-streamed reply", () => {
  const body = Buffer.from(
    JSON.stringify({
      object: "response",
      output: [
        { type: "reasoning", summary: [] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "We deploy to Railway." }],
        },
      ],
    }),
    "utf8",
  );
  assert.equal(extractResponsesAssistantText(body, "application/json"), "We deploy to Railway.");
});

test("responses: assistant text is read from the SSE delta stream", () => {
  const sse = [
    'data: {"type":"response.created","response":{"id":"r"}}',
    'data: {"type":"response.output_text.delta","delta":"We deploy "}',
    'data: {"type":"response.output_text.delta","delta":"to Railway."}',
    'data: {"type":"response.output_text.done","text":"We deploy to Railway."}',
    "data: [DONE]",
    "",
  ].join("\n");
  assert.equal(
    extractResponsesAssistantText(Buffer.from(sse, "utf8"), "text/event-stream"),
    "We deploy to Railway.",
  );
});

test("responses: a truncated or malformed body yields no assistant text", () => {
  assert.equal(extractResponsesAssistantText(Buffer.from("{oops", "utf8"), "application/json"), "");
  assert.equal(
    extractResponsesAssistantText(Buffer.from('data: {"type":"resp', "utf8"), "text/event-stream"),
    "",
  );
});

// ---- through the proxy ------------------------------------------------

type Recorded = { path: string; body: string; contentLength?: string };

async function withResponsesProxy(
  serverOpts: Omit<Parameters<typeof createProxyServer>[0], "upstreams">,
  run: (base: string, seen: Recorded[]) => Promise<void>,
  upstreamReply: (body: string) => { status?: number; headers?: Record<string, string>; body: string } = () => ({
    body: JSON.stringify({
      object: "response",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
    }),
  }),
): Promise<void> {
  const seen: Recorded[] = [];
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({
        path: req.url ?? "",
        body,
        contentLength: req.headers["content-length"],
      });
      const reply = upstreamReply(body);
      res.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
        ...(reply.headers ?? {}),
      });
      res.end(reply.body);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const proxy = createProxyServer({
    ...serverOpts,
    upstreams: { openai: `http://127.0.0.1:${upstreamPort}` },
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const { port } = proxy.address() as AddressInfo;

  try {
    await run(`http://127.0.0.1:${port}/__klio/upstream/openai/v1/responses`, seen);
  } finally {
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await new Promise<void>((r) => proxy.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
}

const hit = () => ({ memories: MEMS, reason: "hit" as const });

test("proxy: a Codex-shaped request is injected on /v1/responses", async () => {
  await withResponsesProxy({ config: CONFIG, recall: hit }, async (url, seen) => {
    const body = codexBody();
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(res.status, 200);
    await res.text();

    assert.equal(res.headers.get("x-klio-injected"), "2");
    assert.equal(res.headers.get("x-klio-injected-reason"), "hit");

    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, "/v1/responses");
    const forwarded = Buffer.from(seen[0].body, "utf8");
    assert.ok(String(parse(forwarded)["instructions"]).includes("Railway"));
    assertOnlyFieldChanged(body, forwarded, "instructions");
    // Injection changes the body length, so the forwarded
    // content-length must be recomputed — never copied from the client.
    assert.notEqual(seen[0].contentLength, String(body.length));
    assert.equal(
      seen[0].contentLength,
      String(Buffer.byteLength(seen[0].body, "utf8")),
      "content-length must match the bytes actually sent",
    );
  });
});

test("proxy: the responses path reports the same skip-reason vocabulary", async () => {
  // No cloud config at all.
  await withResponsesProxy({ config: null }, async (url) => {
    const res = await fetch(url, { method: "POST", body: codexBody() });
    await res.text();
    assert.equal(res.headers.get("x-klio-injected-reason"), "no-config");
    assert.equal(res.headers.get("x-klio-injected"), "0");
  });

  // Injection killed.
  await withResponsesProxy({ config: CONFIG, recall: hit, inject: false }, async (url, seen) => {
    const body = codexBody();
    const res = await fetch(url, { method: "POST", body });
    await res.text();
    assert.equal(res.headers.get("x-klio-injected-reason"), "disabled");
    assert.ok(Buffer.from(seen[0].body, "utf8").equals(body), "kill switch forwards raw bytes");
  });

  // Nothing to query on.
  await withResponsesProxy({ config: CONFIG, recall: hit }, async (url) => {
    const res = await fetch(url, {
      method: "POST",
      body: Buffer.from(JSON.stringify({ model: "m", input: [] }), "utf8"),
    });
    await res.text();
    assert.equal(res.headers.get("x-klio-injected-reason"), "no-query");
  });

  // Memories in hand, body not safely mutable.
  await withResponsesProxy({ config: CONFIG, recall: hit }, async (url) => {
    const res = await fetch(url, {
      method: "POST",
      body: Buffer.from(JSON.stringify(parse(codexBody({ instructions: 7 }))), "utf8"),
    });
    await res.text();
    assert.equal(res.headers.get("x-klio-injected-reason"), "not-injectable");
  });

  // Not a shape this proxy transforms.
  await withResponsesProxy({ config: CONFIG, recall: hit }, async (url) => {
    const res = await fetch(url.replace("/v1/responses", "/v1/models"), { method: "GET" });
    await res.text();
    assert.equal(res.headers.get("x-klio-injected-reason"), "not-applicable");
  });
});

test("proxy: the responses path captures the conversation", async () => {
  const captured: { shape?: string; body: string }[] = [];
  await withResponsesProxy(
    {
      config: CONFIG,
      recall: hit,
      captureEnabled: true,
      capture: async (opts) => {
        captured.push({ shape: opts.shape, body: opts.requestBody.toString("utf8") });
      },
    },
    async (url) => {
      const res = await fetch(url, { method: "POST", body: codexBody() });
      await res.text();
      await new Promise((r) => setTimeout(r, 50));
    },
  );
  assert.equal(captured.length, 1);
  assert.equal(captured[0].shape, "responses");
  assert.ok(captured[0].body.includes("where do we deploy?"));
  assert.ok(
    !captured[0].body.includes("Railway"),
    "capture must see the ORIGINAL request, not the injected one",
  );
});

test("proxy: the capture kill switch applies to the responses path too", async () => {
  let captures = 0;
  await withResponsesProxy(
    {
      config: CONFIG,
      recall: hit,
      captureEnabled: false,
      capture: async () => {
        captures += 1;
      },
    },
    async (url) => {
      const res = await fetch(url, { method: "POST", body: codexBody() });
      await res.text();
      await new Promise((r) => setTimeout(r, 50));
    },
  );
  assert.equal(captures, 0);
});

test("proxy: capture still fires on the responses path when injection is off", async () => {
  let captures = 0;
  await withResponsesProxy(
    {
      config: CONFIG,
      recall: hit,
      inject: false,
      captureEnabled: true,
      capture: async () => {
        captures += 1;
      },
    },
    async (url) => {
      const res = await fetch(url, { method: "POST", body: codexBody() });
      await res.text();
      await new Promise((r) => setTimeout(r, 50));
    },
  );
  assert.equal(captures, 1, "the two toggles are independent");
});

test("proxy: an upstream error on the responses path is relayed, never authored", async () => {
  await withResponsesProxy(
    { config: CONFIG, recall: hit },
    async (url) => {
      const res = await fetch(url, { method: "POST", body: codexBody() });
      assert.equal(res.status, 429);
      assert.equal((await res.json() as { error: string }).error, "rate limited");
    },
    () => ({ status: 429, body: JSON.stringify({ error: "rate limited" }) }),
  );
});
