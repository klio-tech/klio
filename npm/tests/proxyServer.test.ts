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
  run: (proxyBase: string) => Promise<void>,
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
    await run(`http://127.0.0.1:${port}`);
  } finally {
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
