import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AddressInfo } from "node:net";

import { createProxyServer } from "../src/proxy/server.js";

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
