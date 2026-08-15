import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { createProxyServer, startProxy } from "../src/proxy/server.js";

const CONFIG = { apiKey: "k", agentId: "a", baseUrl: "https://api.example" };

async function withServer(
  opts: Parameters<typeof createProxyServer>[0],
  run: (base: string) => Promise<void>,
) {
  const server = createProxyServer(opts);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/**
 * Runs the proxy against a REAL `node:http` upstream, using the REAL
 * global `fetch` (no `fetchImpl` override) for the proxy→upstream hop.
 * This is deliberately heavier than `withServer`: the bugs this covers
 * (undici refusing an already-read body stream, undici's transparent
 * gzip decompression, real socket-level abort/reset semantics) live in
 * layers a mocked `fetchImpl` bypasses entirely.
 */
async function withRealUpstream(
  upstreamHandler: http.RequestListener,
  serverOpts: Omit<Parameters<typeof createProxyServer>[0], "upstreams" | "fetchImpl">,
  run: (proxyBase: string, proxyServer: http.Server) => Promise<void>,
) {
  const upstream = http.createServer(upstreamHandler);
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const proxy = createProxyServer({
    ...serverOpts,
    upstreams: { anthropic: `http://127.0.0.1:${upstreamPort}` },
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const { port } = proxy.address() as AddressInfo;

  try {
    await run(`http://127.0.0.1:${port}`, proxy);
  } finally {
    // `close()` alone waits for every still-open connection to end, and
    // several tests below deliberately leave connections stalled — an
    // over-cap body still relaying to an upstream that is not reading it
    // outlives the assertion that ended the test. Forcing them shut
    // keeps teardown bounded and independent of what the test left
    // behind. (Not demonstrated to be load-bearing: the suite also
    // completes without it. Kept because a hung `close()` would hide
    // every result in the run, which is a bad failure mode to leave
    // available.)
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await new Promise<void>((r) => proxy.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
}

test("health responds without touching upstream", async () => {
  await withServer(
    { config: CONFIG, fetchImpl: (async () => { throw new Error("upstream must not be called"); }) as any },
    async (base) => {
      const res = await fetch(`${base}/__klio/health`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).status, "ok");
    },
  );
});

test("a non-messages request is forwarded verbatim with its status", async () => {
  let seenUrl = "";
  await withServer(
    {
      config: CONFIG,
      inject: false,
      fetchImpl: (async (url: any) => {
        seenUrl = String(url);
        return new Response("upstream-body", { status: 418, headers: { "x-custom": "kept" } });
      }) as any,
    },
    async (base) => {
      const res = await fetch(`${base}/v1/models`);
      assert.equal(res.status, 418);
      assert.equal(res.headers.get("x-custom"), "kept");
      assert.equal(await res.text(), "upstream-body");
      assert.match(seenUrl, /api\.anthropic\.com\/v1\/models$/);
    },
  );
});

test("a messages POST is injected and reports the count", async () => {
  let forwarded: any = null;
  await withServer(
    {
      config: CONFIG,
      recall: async () => [{ id: "m1", content: "remembered thing" }],
      fetchImpl: (async (_u: any, init: any) => {
        forwarded = JSON.parse(init.body.toString());
        return new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }] }), { status: 200 });
      }) as any,
    },
    async (base) => {
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ system: "base", messages: [{ role: "user", content: "q" }] }),
      });
      assert.equal(res.headers.get("x-klio-injected"), "1");
      assert.ok(JSON.stringify(forwarded.system).includes("remembered thing"));
    },
  );
});

test("a recall failure still forwards the request, injected 0", async () => {
  await withServer(
    {
      config: CONFIG,
      recall: async () => { throw new Error("recall exploded"); },
      fetchImpl: (async () => new Response("{}", { status: 200 })) as any,
    },
    async (base) => {
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "q" }] }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-klio-injected"), "0");
    },
  );
});

test("an unreachable upstream returns 502 with the error header, never hangs", async () => {
  await withServer(
    {
      config: CONFIG,
      inject: false,
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as any,
    },
    async (base) => {
      const res = await fetch(`${base}/v1/messages`, { method: "POST", body: "{}" });
      assert.equal(res.status, 502);
      assert.ok(res.headers.get("x-klio-proxy-error"));
      assert.equal((await res.json()).type, "error");
    },
  );
});

test("the upstream prefix selects a named upstream and is stripped", async () => {
  let seenUrl = "";
  await withServer(
    {
      config: CONFIG,
      inject: false,
      fetchImpl: (async (url: any) => { seenUrl = String(url); return new Response("ok"); }) as any,
    },
    async (base) => {
      await fetch(`${base}/__klio/upstream/openai/v1/chat/completions`, { method: "POST", body: "{}" });
      assert.equal(seenUrl, "https://api.openai.com/v1/chat/completions");
    },
  );
});

test("capture fires after the response, with the assistant text", async () => {
  let captured: any = null;
  await withServer(
    {
      config: CONFIG,
      recall: async () => [],
      captureEnabled: true,
      capture: (async (o: any) => { captured = o; }) as any,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ content: [{ type: "text", text: "the answer" }] }), { status: 200 })) as any,
    },
    async (base) => {
      await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "q" }] }),
      });
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(captured, "capture should have been invoked");
      assert.equal(captured.assistantText, "the answer");
    },
  );
});

test("content-length on a forwarded request always matches the actual bytes sent, injected or not", async () => {
  let seenContentLength = "";
  let seenBodyLength = 0;
  await withServer(
    {
      config: CONFIG,
      recall: async () => [{ id: "m1", content: "a memory that grows the body" }],
      fetchImpl: (async (_u: any, init: any) => {
        seenContentLength = init.headers["content-length"];
        seenBodyLength = Buffer.byteLength(init.body);
        return new Response("{}", { status: 200 });
      }) as any,
    },
    async (base) => {
      const originalBody = JSON.stringify({ messages: [{ role: "user", content: "q" }] });
      await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(originalBody.length) },
        body: originalBody,
      });
      assert.notEqual(Number(seenContentLength), originalBody.length, "body grew due to injection");
      assert.equal(Number(seenContentLength), seenBodyLength);
    },
  );
});

test("non-messages POST forwards with content-length matching the exact bytes sent", async () => {
  let seenContentLength = "";
  let seenBodyLength = 0;
  await withServer(
    {
      config: CONFIG,
      inject: false,
      fetchImpl: (async (_u: any, init: any) => {
        seenContentLength = init.headers["content-length"];
        seenBodyLength = Buffer.byteLength(init.body);
        return new Response("ok", { status: 200 });
      }) as any,
    },
    async (base) => {
      const body = JSON.stringify({ hello: "world" });
      await fetch(`${base}/v1/models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(Number(seenContentLength), seenBodyLength);
      assert.equal(Number(seenContentLength), Buffer.byteLength(body));
    },
  );
});

test("streaming is not buffered: the client receives the first chunk before upstream closes", async () => {
  let resolveUpstreamClose: () => void = () => {};
  const upstreamClosed = new Promise<void>((r) => { resolveUpstreamClose = r; });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("event: first\ndata: {}\n\n"));
      // Hold the stream open until the test explicitly lets it close.
      upstreamClosed.then(() => {
        controller.enqueue(new TextEncoder().encode("event: second\ndata: {}\n\n"));
        controller.close();
      });
    },
  });

  await withServer(
    {
      config: CONFIG,
      inject: false,
      fetchImpl: (async () =>
        new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as any,
    },
    async (base) => {
      const res = await fetch(`${base}/v1/messages`, { method: "POST", body: "{}" });
      const reader = res.body!.getReader();
      const { value, done } = await reader.read();
      assert.equal(done, false);
      const firstChunkText = new TextDecoder().decode(value);
      assert.match(firstChunkText, /event: first/);

      // At this point the upstream has NOT closed yet — a buffering
      // implementation could not have delivered anything to the client.
      resolveUpstreamClose();
      const rest = await reader.read();
      assert.equal(rest.done, false);
    },
  );
});

// M9: the test above deliberately runs with `inject: false`, so it never
// exercises `pipeline(upstream, tee, res)` — the branch that runs
// whenever `captureEnabled` is on, which is the configuration real users
// with capture wired up will actually run. This is the same
// non-buffering proof, but through the tee.
test("streaming through the capture tee is still not buffered: the client gets the first chunk before upstream closes", async () => {
  let resolveUpstreamClose: () => void = () => {};
  const upstreamClosed = new Promise<void>((r) => { resolveUpstreamClose = r; });
  let captured: any = null;

  const sse = (obj: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sse({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } }));
      // Hold the stream open until the test explicitly lets it close.
      upstreamClosed.then(() => {
        controller.enqueue(sse({ type: "content_block_delta", delta: { type: "text_delta", text: " world" } }));
        controller.enqueue(sse({ type: "message_stop" }));
        controller.close();
      });
    },
  });

  await withServer(
    {
      config: CONFIG,
      recall: async () => [],
      captureEnabled: true,
      capture: (async (o: any) => { captured = o; }) as any,
      fetchImpl: (async () =>
        new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as any,
    },
    async (base) => {
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "q" }] }),
      });
      const reader = res.body!.getReader();
      const { value, done } = await reader.read();
      assert.equal(done, false);
      assert.match(new TextDecoder().decode(value), /Hello/);

      // At this point the upstream has NOT closed yet — a buffering
      // implementation (or one that dropped the tee for a plain pipe)
      // could not have delivered anything to the client yet.
      resolveUpstreamClose();
      let chunk = await reader.read();
      while (!chunk.done) chunk = await reader.read();

      await new Promise((r) => setTimeout(r, 50));
      assert.ok(captured, "capture should have fired through the tee");
      assert.equal(captured.assistantText, "Hello world");
    },
  );
});

// M8: SSE assistant-text extraction, exercised directly — this is the
// only shape real Claude Code traffic (`stream: true`) actually takes.
test("capture extracts assistant text from a realistic SSE stream", async () => {
  let captured: any = null;
  const events = [
    { type: "message_start", message: { id: "msg_1", role: "assistant", content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" },
  ];
  const sseBody = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

  await withServer(
    {
      config: CONFIG,
      recall: async () => [],
      captureEnabled: true,
      capture: (async (o: any) => { captured = o; }) as any,
      fetchImpl: (async () =>
        new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } })) as any,
    },
    async (base) => {
      await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "q" }] }),
      });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(captured.assistantText, "Hello world");
    },
  );
});

// I5: KLIO_PROXY_INJECT and KLIO_PROXY_CAPTURE are independent toggles.
// Disabling injection must not silently disable capture too.
test("capture fires independently of inject: false", async () => {
  let captured: any = null;
  await withServer(
    {
      config: CONFIG,
      inject: false,
      captureEnabled: true,
      capture: (async (o: any) => { captured = o; }) as any,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ content: [{ type: "text", text: "the answer" }] }), { status: 200 })) as any,
    },
    async (base) => {
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "q" }] }),
      });
      // Injection never ran (inject: false), so nothing was recalled or injected.
      assert.equal(res.headers.get("x-klio-injected"), "0");

      await new Promise((r) => setTimeout(r, 50));
      assert.ok(captured, "capture should fire even when injection is disabled");
      assert.equal(captured.assistantText, "the answer");
    },
  );
});

// C2 regression: exiting the body-reading loop early must not destroy
// the live request stream. Before the fix (an async `for await...of req`
// with an early `return`), an over-cap request would hang forever — the
// destroyed `req` could never emit "end", so nothing downstream ever
// completed. This proves the request completes and the FULL raw body
// (all of it, unmodified) reaches the upstream.
// C2, rewritten against a REAL upstream and the REAL global fetch.
//
// The first version of this test used a mocked `fetchImpl` that
// iterated `init.body` directly — which bypasses undici's body
// EXTRACTION step entirely, the exact layer where the real bug lived
// ("Response body object should not be disturbed or locked", thrown
// because the request stream handed to fetch had already been read
// from). That made the test pass against both the broken version and
// the fixed version, proving nothing. This version runs the proxy
// against a real `node:http` upstream through the real `fetch`, and
// verifies the upstream RECEIVED every byte — via a sha256 of the
// exact bytes it saw — rather than merely that the proxy returned 200.
test(
  "a request over the body cap reaches a REAL upstream with every byte intact (sha256 match)",
  { timeout: 20000 },
  async () => {
    let receivedHash = "";
    let receivedLength = 0;

    await withRealUpstream(
      (req, res) => {
        const hash = createHash("sha256");
        let length = 0;
        req.on("data", (chunk: Buffer) => {
          hash.update(chunk);
          length += chunk.length;
        });
        req.on("end", () => {
          receivedHash = hash.digest("hex");
          receivedLength = length;
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        });
      },
      { config: CONFIG, inject: false },
      async (base) => {
        const chunkSize = 1024 * 1024;
        const totalChunks = 11; // over the 10 MB cap
        const expectedHash = createHash("sha256");
        const chunks: Buffer[] = [];
        for (let i = 0; i < totalChunks; i++) {
          // Vary content per chunk so truncation, reordering, or
          // duplication can't hide behind a repeated byte pattern.
          const chunk = Buffer.alloc(chunkSize, i % 256);
          chunks.push(chunk);
          expectedHash.update(chunk);
        }
        const expectedDigest = expectedHash.digest("hex");
        const expectedLength = chunkSize * totalChunks;

        const requestBody = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        });
        const res = await fetch(`${base}/v1/models`, {
          method: "POST",
          body: requestBody,
          // @ts-expect-error Node fetch requires duplex for a streamed body.
          duplex: "half",
        });
        assert.equal(res.status, 200);
        assert.equal(receivedLength, expectedLength, "upstream must receive every byte");
        assert.equal(
          receivedHash,
          expectedDigest,
          "upstream's bytes must match exactly — no truncation, no corruption, no drop",
        );
      },
    );
  },
);

// C1, against a real upstream: a mid-stream connection reset must not
// take the proxy process down with it. Ordinary traffic for a long SSE
// response from api.anthropic.com.
test(
  "a mid-stream upstream connection reset does not crash the proxy — it stays alive for the next request",
  { timeout: 10000 },
  async () => {
    let requestNum = 0;
    await withRealUpstream(
      (req, res) => {
        requestNum += 1;
        if (requestNum === 1) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("event: first\ndata: {}\n\n");
          // Simulate an upstream TLS/connection reset mid-stream: tear
          // down the socket without ending the response cleanly.
          setTimeout(() => req.socket.destroy(), 20);
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ content: [{ type: "text", text: "still alive" }] }));
        }
      },
      { config: CONFIG, inject: false },
      async (base) => {
        // First request: upstream resets mid-stream. The only
        // requirement here is that the proxy PROCESS survives — the
        // client may see a partial response, a network error, or a
        // clean-enough close; all are acceptable outcomes of an
        // upstream reset.
        await fetch(`${base}/v1/messages`, { method: "POST", body: "{}" }).catch(() => {});

        // Second request, same proxy server instance. If the reset
        // above had escaped as an unhandled "error" event, the process
        // would already be dead and this would never resolve.
        const res2 = await fetch(`${base}/v1/messages`, { method: "POST", body: "{}" });
        assert.equal(res2.status, 200);
        assert.equal(await res2.text(), JSON.stringify({ content: [{ type: "text", text: "still alive" }] }));
      },
    );
  },
);

// I3, against a real upstream: aborting the client request must tear
// down the proxy→upstream connection, not leak it. Claude Code aborts
// streams constantly (ESC, tool-loop cancellation).
test(
  "a client abort tears down the upstream connection instead of leaking it",
  { timeout: 10000 },
  async () => {
    let writtenCount = 0;
    let stoppedWritingAt = -1;

    await withRealUpstream(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const interval = setInterval(() => {
          writtenCount += 1;
          try {
            res.write(`event: tick\ndata: ${writtenCount}\n\n`);
          } catch {
            // Connection already gone; the "close" handler below covers it.
          }
        }, 10);
        res.on("close", () => {
          clearInterval(interval);
          stoppedWritingAt = writtenCount;
        });
      },
      { config: CONFIG, inject: false },
      async (base) => {
        const controller = new AbortController();
        const res = await fetch(`${base}/v1/messages`, {
          method: "POST",
          body: "{}",
          signal: controller.signal,
        });
        const reader = res.body!.getReader();
        await reader.read(); // first chunk
        controller.abort();

        // Give the abort time to propagate: client → proxy → upstream
        // connection close → upstream's "close" handler.
        await new Promise((r) => setTimeout(r, 300));
        assert.ok(stoppedWritingAt >= 0, "upstream should have observed the connection close");

        // The actual leak this guards against: the upstream kept
        // producing (and Klio kept paying for) tokens nobody reads.
        // Confirm it actually stopped, rather than just eventually.
        const countAfterGrace = writtenCount;
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(writtenCount, countAfterGrace, "upstream must stop producing once the client is gone");
      },
    );
  },
);

// I4, for real: an occupied port must reject startProxy's promise, not
// crash the process with an uncaught EADDRINUSE.
test("startProxy rejects instead of crashing when the port is already in use", async () => {
  const blocker = http.createServer((_req, res) => res.end("x"));
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
  const port = (blocker.address() as AddressInfo).port;
  try {
    await assert.rejects(() => startProxy({ port, host: "127.0.0.1", inject: false, captureEnabled: false }));
  } finally {
    await new Promise<void>((r) => blocker.close(() => r()));
  }
});

// Minor fix: startProxy must report the port it actually bound, not the
// requested one — `port: 0` (ephemeral) previously reported back `0`.
test("startProxy reports the actual bound port, not the requested one", async () => {
  const { server, port } = await startProxy({ port: 0, host: "127.0.0.1", inject: false, captureEnabled: false });
  try {
    assert.notEqual(port, 0);
    assert.equal(port, (server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// M6, against a real upstream: a SYNCHRONOUS throw from the `capture`
// callback (not merely a rejected promise) must not crash the proxy —
// it fires from inside the response's "finish" listener, strictly
// after the client's response has already gone out.
test("a synchronous throw from the capture callback does not crash the proxy", async () => {
  await withRealUpstream(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
    },
    {
      config: CONFIG,
      recall: async () => [],
      captureEnabled: true,
      capture: (() => {
        throw new Error("capture blew up synchronously");
      }) as any,
    },
    async (base) => {
      const res1 = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "q" }] }),
      });
      assert.equal(res1.status, 200);
      assert.equal(await res1.text(), JSON.stringify({ content: [{ type: "text", text: "ok" }] }));

      // If the throw had escaped the guard, this is an uncaught
      // exception and the server is already dead by now.
      const res2 = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "q" }] }),
      });
      assert.equal(res2.status, 200);
    },
  );
});

// headers.ts: undici transparently decompresses a gzip upstream body
// but leaves `content-encoding: gzip` on the Response — forwarding it
// verbatim tells the client the (now-plaintext) body is still gzipped.
// Any client that honours the header fails to decode it.
test("a gzip-compressed upstream response is forwarded without a stale content-encoding header", async () => {
  await withRealUpstream(
    (_req, res) => {
      const plaintext = Buffer.from(JSON.stringify({ content: [{ type: "text", text: "gzipped reply" }] }));
      const compressed = gzipSync(plaintext);
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(compressed.length),
      });
      res.end(compressed);
    },
    { config: CONFIG, inject: false },
    async (base) => {
      const res = await fetch(`${base}/v1/messages`, { method: "POST", body: "{}" });
      assert.equal(res.status, 200);
      assert.equal(
        res.headers.get("content-encoding"),
        null,
        "a body undici already decompressed must not be re-labelled gzip",
      );
      const text = await res.text();
      assert.equal(text, JSON.stringify({ content: [{ type: "text", text: "gzipped reply" }] }));
    },
  );
});

// FAIL OPEN, absolutely. An upstream that answers WITHOUT reading the
// (over-cap) request body — a 413 rejected on headers alone — was
// reachable and returned a well-formed response, so the proxy must
// relay it. The only 5xx this server may ever author is the reserved
// 502 for a genuinely unreachable upstream.
//
// A previous round set `connection: close` on the over-cap path, which
// made the upstream hang up the instant it finished responding, while
// the proxy was still writing the remaining megabytes; the write
// EPIPE'd and `fetch()` rejected instead of yielding the response it
// already held, turning the 413 into a Klio-authored `api_error`. A
// single iteration against that revision (f795722) only catches this
// intermittently, so the exchange runs repeatedly to make the coverage
// reliable.
//
// Measured directly against f795722, 5 batches of 8 iterations each:
//   fetch() with a streamed body, fresh pair per iteration (this shape):
//     20/40 non-413
//   raw http.request, fresh pair per iteration:
//     18/40 non-413
//   fetch() with a streamed body, one warm pair reused across a batch:
//     24/40 non-413
// The defect is not specific to `fetch` vs. `http.request`, and it is
// not specific to a cold pair — every shape tried reproduces it at
// roughly 50% per iteration, so neither is load-bearing coverage on its
// own. 8 iterations is kept because it costs well under a second
// against a passing proxy and, at that per-iteration rate, reliably
// fails this test — confirmed across 5 consecutive full-file runs
// against f795722 — so there is no measured runtime to reclaim by
// shrinking it further.
test(
  "an upstream that responds early without reading the over-cap body has its 413 relayed, never replaced by a 502",
  { timeout: 60000 },
  async () => {
    const ITERATIONS = 8;

    for (let i = 0; i < ITERATIONS; i++) {
      // A fresh proxy and upstream per iteration. Not required to
      // reproduce the defect (see measurements above) but kept for
      // parity with how the proxy is actually used — each request in
      // production can land on a different upstream connection.
      await withRealUpstream(
        (_req, res) => {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "too large" } }));
        },
        { config: CONFIG, inject: false },
        async (base) => {
          const requestBody = new ReadableStream<Uint8Array>({
            start(controller) {
              for (let c = 0; c < 15; c++) controller.enqueue(Buffer.alloc(1024 * 1024, c % 256));
              controller.close();
            },
          });
          const res = await fetch(`${base}/v1/models`, {
            method: "POST",
            body: requestBody,
            // @ts-expect-error Node fetch requires duplex for a streamed body.
            duplex: "half",
          });
          assert.equal(res.status, 413, `iteration ${i}: the upstream's own 413 must be relayed, not replaced`);
          assert.equal(
            JSON.parse(await res.text()).error.type,
            "invalid_request_error",
            `iteration ${i}: the relayed body must be the upstream's, not a Klio-authored api_error`,
          );
        },
      );
    }
  },
);

// `BufferedThenLive.abandon()`. Once the response has gone out, a
// still-uploading client's over-cap body must be DRAINED and discarded
// — not left paused (reaped only by Node's 300s default
// `server.requestTimeout`), and not destroyed either, which would tear
// down the socket the client is reading its response from.
//
// Draining is something only the proxy can do, which is the point of
// this shape: the client below writes its whole body and never hangs
// up, so `req` reaching "end" can only come from `abandon()` resuming
// it. Asserting that the client SOCKET closes does not test the proxy at
// all — the client's own teardown satisfies that, and an `abandon()`
// deliberately broken to detach without resuming still passes it. This
// assertion does not: broken that way, it fails, but not with one fixed
// symptom — measured 10 runs against a detach-without-resume break: 3
// failed with `write EPIPE`, 7 failed with the "drained 0/1" message
// below (the deadline expiring because `req` never reached "end").
test(
  "an abandoned over-cap request body is drained by the proxy, not left paused",
  { timeout: 20000 },
  async () => {
    const drained: boolean[] = [];

    await withRealUpstream(
      (_req, res) => {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "too large" } }));
      },
      { config: CONFIG, inject: false },
      async (base, proxyServer) => {
        // `http.Server` supports more than one "request" listener; this
        // one only watches, never touches `req`/`res`, and never
        // consumes the body — so "end" here comes from the proxy alone.
        proxyServer.on("request", (req) => {
          const index = drained.length;
          drained.push(false);
          req.on("end", () => { drained[index] = true; });
        });

        const url = new URL(base);
        // A raw request, not `fetch`: this client writes its whole 15 MB
        // regardless of the response arriving first, which is exactly
        // the situation `abandon()` exists for.
        const status = await new Promise<number>((resolve, reject) => {
          const clientReq = http.request(
            { host: url.hostname, port: url.port, path: "/v1/models", method: "POST" },
            (clientRes) => {
              clientRes.resume();
              clientRes.on("end", () => resolve(clientRes.statusCode ?? 0));
            },
          );
          clientReq.on("error", reject);
          for (let c = 0; c < 15; c++) clientReq.write(Buffer.alloc(1024 * 1024, c % 256));
          clientReq.end();
        });
        assert.equal(status, 413, "sanity: the response must have been delivered before the body finished");

        const deadline = Date.now() + 6000;
        while (drained.some((d) => !d) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.ok(
          drained.length > 0 && drained.every((d) => d),
          "the abandoned over-cap body must be drained by the proxy, not left paused until " +
            `the server's request timeout (drained ${drained.filter((d) => d).length}/${drained.length})`,
        );
      },
    );
  },
);

// ---------------------------------------------------------------------
// SLOW-UPSTREAM COVERAGE FOR THE OVER-CAP PATH.
//
// Every other over-cap test in this file runs against a FAST loopback
// upstream, which is precisely the one condition under which an idle
// detector on the client socket never fires. Four rounds of this file
// shipped green while the over-cap path was destroying live, healthy
// connections, because nothing here was ever slow enough to notice.
//
// The over-cap path exists for >10 MB bodies — huge-context requests,
// exactly the ones where a model API's time-to-first-byte is LONGEST
// and where TCP backpressure from a consumer slower than the client is
// the normal state, not an anomaly. The four tests below make each of
// those conditions explicit: a slow first byte, a long mid-stream gap,
// a consumer slower than the client, and a consumer that never reads
// at all.
// ---------------------------------------------------------------------

/** An 11 MB (over-cap) request body of distinguishable 1 MB chunks. */
function overCapBody(totalChunks = 11): { stream: ReadableStream<Uint8Array>; bytes: number } {
  const chunkSize = 1024 * 1024;
  return {
    bytes: chunkSize * totalChunks,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < totalChunks; i++) controller.enqueue(Buffer.alloc(chunkSize, i % 256));
        controller.close();
      },
    }),
  };
}

// An idle detector armed on the shared client socket cannot tell "the
// client is gone" from "the upstream simply hasn't answered yet". A
// 4s time-to-first-byte is unremarkable for a large-context model
// call; it must not cost the client its connection.
test(
  "an over-cap request survives an upstream whose first byte is slower than the idle threshold",
  { timeout: 30000 },
  async () => {
    let receivedLength = 0;
    const upstreamTtfbMs = 4000;

    await withRealUpstream(
      (req, res) => {
        req.on("data", (chunk: Buffer) => { receivedLength += chunk.length; });
        req.on("end", () => {
          setTimeout(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{}");
          }, upstreamTtfbMs);
        });
      },
      { config: CONFIG, inject: false },
      async (base) => {
        const body = overCapBody();
        const started = Date.now();
        const res = await fetch(`${base}/v1/models`, {
          method: "POST",
          body: body.stream,
          // @ts-expect-error Node fetch requires duplex for a streamed body.
          duplex: "half",
        });
        assert.equal(res.status, 200, "a slow-but-healthy upstream must still reach the client");
        await res.text();
        assert.equal(receivedLength, body.bytes, "every byte must still have reached the upstream");
        assert.ok(
          Date.now() - started >= upstreamTtfbMs,
          "sanity: the response really did take longer than the idle threshold",
        );
      },
    );
  },
);

// Anthropic's SSE keep-alive pings are ~10s apart; ordinary gaps
// between content_block_delta events routinely exceed any short idle
// threshold. A gap in the RESPONSE must never tear down the request.
test(
  "an over-cap request survives an SSE gap longer than the idle threshold",
  { timeout: 30000 },
  async () => {
    const gapMs = 3500;

    await withRealUpstream(
      (req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "Hello" } })}\n\n`);
          setTimeout(() => {
            res.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
            res.end();
          }, gapMs);
        });
      },
      { config: CONFIG, inject: false },
      async (base) => {
        const body = overCapBody();
        const res = await fetch(`${base}/v1/models`, {
          method: "POST",
          body: body.stream,
          // @ts-expect-error Node fetch requires duplex for a streamed body.
          duplex: "half",
        });
        assert.equal(res.status, 200);

        // Read the whole stream. A stream torn down mid-gap either
        // throws here or ends without ever delivering message_stop.
        let text = "";
        const reader = res.body!.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += new TextDecoder().decode(value);
        }
        assert.match(text, /message_stop/, "the stream must survive a gap longer than the idle threshold");
      },
    );
  },
);

// The over-cap path relays a body to a consumer that is, by design,
// slower than the client. TCP backpressure then stalls inbound data
// for as long as the consumer takes — quiet that says nothing at all
// about whether the client is still there. Reading that quiet as a
// dead client kills a perfectly healthy upload.
test(
  "an over-cap upload to an upstream slower than the client is not killed by its own backpressure",
  { timeout: 60000 },
  async () => {
    let receivedLength = 0;

    await withRealUpstream(
      (req, res) => {
        // Throttled reader: one burst every 20ms, so a 12 MB body takes
        // several seconds and the proxy's read from the CLIENT stalls
        // far longer than any idle threshold at a stretch.
        req.pause();
        const timer = setInterval(() => req.resume(), 20);
        req.on("data", (chunk: Buffer) => {
          receivedLength += chunk.length;
          req.pause();
        });
        req.on("end", () => {
          clearInterval(timer);
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        });
        req.on("close", () => clearInterval(timer));
      },
      { config: CONFIG, inject: false },
      async (base) => {
        const body = overCapBody(12);
        const res = await fetch(`${base}/v1/models`, {
          method: "POST",
          body: body.stream,
          // @ts-expect-error Node fetch requires duplex for a streamed body.
          duplex: "half",
        });
        assert.equal(res.status, 200, "a backpressured but healthy upload must complete");
        await res.text();
        assert.equal(receivedLength, body.bytes, "every byte of the backpressured upload must arrive");
      },
    );
  },
);

// The hard case, and the one that made every previous round's
// over-cap coverage worthless: an upstream that accepts the connection
// and then reads NOTHING at all for longer than any idle threshold.
// The proxy's write to it stalls, the proxy stops reading the client,
// and the client socket goes completely silent — while both ends are
// perfectly healthy. Anything that reads that silence as a dead client
// destroys a live request.
test(
  "an over-cap upload survives an upstream that reads nothing at all for longer than the idle threshold",
  { timeout: 40000 },
  async () => {
    let receivedLength = 0;
    const deafForMs = 5000;

    await withRealUpstream(
      (req, res) => {
        req.pause();
        setTimeout(() => {
          req.on("data", (chunk: Buffer) => { receivedLength += chunk.length; });
          req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{}");
          });
          req.resume();
        }, deafForMs);
      },
      { config: CONFIG, inject: false },
      async (base) => {
        const body = overCapBody(12);
        const started = Date.now();
        const res = await fetch(`${base}/v1/models`, {
          method: "POST",
          body: body.stream,
          // @ts-expect-error Node fetch requires duplex for a streamed body.
          duplex: "half",
        });
        assert.equal(res.status, 200, "a deaf-then-reading upstream must still complete");
        await res.text();
        assert.equal(receivedLength, body.bytes, "every byte must arrive once the upstream starts reading");
        assert.ok(Date.now() - started >= deafForMs, "sanity: the stall really did outlast the idle threshold");
      },
    );
  },
);
