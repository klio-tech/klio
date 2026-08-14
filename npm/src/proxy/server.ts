// The Node HTTP server that sits between an agent and the model API.
//
// This is the request path of every model call the user makes while the
// proxy is wired in, so the governing rule is FAIL OPEN: nothing this
// file does may keep the agent's request from reaching the model. Any
// Klio-side failure (a bad recall, a broken capture endpoint, an
// unexpected exception in our own code) degrades to "forward the
// request unmodified" rather than an error of our own. The only 5xx
// this server ever returns is a 502 for a genuinely unreachable
// upstream — the one failure it cannot forward past.
//
// Two behaviours are load-bearing enough to call out explicitly:
//
//   * Content-Length. Injection changes the body length, so the
//     forwarded `content-length` is ALWAYS recomputed from the actual
//     bytes being sent — never copied from the client's original
//     header — on every buffered request, injected or not.
//   * Streaming. The response is piped straight through
//     (`Readable.fromWeb(upstream.body).pipe(nodeRes)`); it is never
//     buffered and then written, which would break SSE — the format
//     every real Claude Code request uses. Capture gets its copy by
//     teeing the stream through a pass-through transform that
//     accumulates a bounded copy while forwarding every chunk
//     immediately.

import * as http from "node:http";
import { Readable, Transform } from "node:stream";

import { readCloudConfig, type CloudConfig } from "../cloudConfig.js";
import { PROXY_HEALTH_PATH, PROXY_HOST, PROXY_PORT } from "./constants.js";
import { emitCapture, type EmitCaptureOptions } from "./capture.js";
import { filterRequestHeaders, filterResponseHeaders } from "./headers.js";
import { injectMemories, type Memory } from "./inject.js";
import { createRecaller } from "./recall.js";

/** Above this, a request body is forwarded raw, unbuffered, uninjected. */
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

/** Above this, capture stops accumulating a copy of the response. */
const MAX_CAPTURE_BYTES = 1 * 1024 * 1024;

const DEFAULT_UPSTREAMS: Readonly<Record<string, string>> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

export type ProxyUpstreams = Record<string, string>;

export type CreateProxyServerOptions = {
  config: CloudConfig | null;
  upstreams?: ProxyUpstreams;
  recall?: (query: string) => Promise<Memory[]>;
  capture?: (opts: EmitCaptureOptions) => Promise<void>;
  fetchImpl?: typeof fetch;
  /** Default true. `false` disables the injection (and capture) path entirely. */
  inject?: boolean;
  /** Default false. Requires `config` to actually fire. */
  captureEnabled?: boolean;
};

type ResolvedUpstream =
  | { ok: true; name: string; base: string; path: string; search: string }
  | { ok: false };

/** Resolve which upstream a request targets, stripping the `/__klio/upstream/<name>` prefix. */
function resolveUpstream(
  rawUrl: string,
  upstreams: Readonly<Record<string, string>>,
): ResolvedUpstream {
  const parsed = new URL(rawUrl, "http://internal.invalid");
  const prefixMatch = parsed.pathname.match(/^\/__klio\/upstream\/([^/]+)(\/.*)?$/);

  const name = prefixMatch ? prefixMatch[1] : "anthropic";
  const path = prefixMatch ? (prefixMatch[2] ?? "/") : parsed.pathname;
  const base = upstreams[name];
  if (!base) return { ok: false };
  return { ok: true, name, base, path, search: parsed.search };
}

/** Extract text from an Anthropic-shaped content value (string, or block array with `.text`). */
function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const text = (block as Record<string, unknown>)["text"];
      return typeof text === "string" ? text : "";
    })
    .filter((t) => t !== "")
    .join("\n");
}

/** The query the recaller receives: the last `user` message's text. */
function lastUserMessageText(parsedBody: unknown): string {
  if (!parsedBody || typeof parsedBody !== "object") return "";
  const messages = (parsedBody as Record<string, unknown>)["messages"];
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Record<string, unknown> | null;
    if (message && message["role"] === "user") return blockText(message["content"]);
  }
  return "";
}

const SSE_DATA_LINE = /^data:\s*(.+)$/;

/**
 * Best-effort assistant text out of a (possibly teed, possibly
 * truncated) response body, for capture only. Handles both a plain
 * Messages JSON response and an SSE stream of `content_block_delta`
 * events. Never throws — a malformed or truncated body just yields "".
 */
function extractAssistantText(buf: Buffer, contentType: string | undefined): string {
  const text = buf.toString("utf8");

  if (contentType && contentType.includes("text/event-stream")) {
    const parts: string[] = [];
    for (const line of text.split("\n")) {
      const match = line.match(SSE_DATA_LINE);
      if (!match) continue;
      const payload = match[1].trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        const event = JSON.parse(payload) as Record<string, unknown>;
        const delta = event["delta"] as Record<string, unknown> | undefined;
        if (delta && typeof delta["text"] === "string") parts.push(delta["text"] as string);
      } catch {
        // Malformed or truncated SSE payload line — skip it.
      }
    }
    return parts.join("");
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return blockText(parsed["content"]);
  } catch {
    return "";
  }
}

/** Read the request body, capped at {@link MAX_REQUEST_BODY_BYTES}. */
async function readRequestBody(
  req: http.IncomingMessage,
): Promise<{ capped: false; body: Buffer } | { capped: true; stream: Readable }> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    total += chunk.length;
    chunks.push(chunk);

    if (total > MAX_REQUEST_BODY_BYTES) {
      // Over the cap: stop buffering. Replay what we already consumed,
      // then splice in whatever is left of the live request stream, so
      // no bytes are lost and nothing is held in memory beyond this
      // point. The caller forwards this raw, with no injection.
      const alreadyRead = Readable.from(chunks);
      const combined = new PassthroughFromReadables(alreadyRead, req);
      return { capped: true, stream: combined };
    }
  }

  return { capped: false, body: Buffer.concat(chunks, total) };
}

/** A Readable that plays `first` to completion, then relays `second`. */
class PassthroughFromReadables extends Readable {
  private active: Readable;

  constructor(
    private readonly first: Readable,
    private readonly second: Readable,
  ) {
    super();
    this.active = first;
    this.first.on("data", (chunk: Buffer) => {
      if (!this.push(chunk)) this.first.pause();
    });
    this.first.on("end", () => {
      this.active = this.second;
      this.second.on("data", (chunk: Buffer) => {
        if (!this.push(chunk)) this.second.pause();
      });
      this.second.on("end", () => this.push(null));
      this.second.on("error", (err) => this.destroy(err));
      this.second.resume();
    });
    this.first.on("error", (err) => this.destroy(err));
  }

  override _read(): void {
    this.active.resume();
  }
}

/** Accumulates up to {@link MAX_CAPTURE_BYTES} of a piped stream while forwarding every chunk untouched. */
class CapturingTee extends Transform {
  private readonly chunks: Buffer[] = [];
  private total = 0;

  override _transform(chunk: Buffer, _enc: string, callback: (error?: Error | null, data?: unknown) => void): void {
    if (this.total < MAX_CAPTURE_BYTES) {
      const room = MAX_CAPTURE_BYTES - this.total;
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      this.chunks.push(slice);
      this.total += slice.length;
    }
    callback(null, chunk);
  }

  captured(): Buffer {
    return Buffer.concat(this.chunks, this.total);
  }
}

function sendJson(res: http.ServerResponse, status: number, headers: Record<string, string>, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, { ...headers, "content-type": "application/json", "content-length": String(payload.length) });
  res.end(payload);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createProxyServer(opts: CreateProxyServerOptions): http.Server {
  const upstreams: Record<string, string> = { ...DEFAULT_UPSTREAMS, ...(opts.upstreams ?? {}) };
  const recall = opts.recall ?? (async () => []);
  const capture = opts.capture ?? emitCapture;
  const doFetch = opts.fetchImpl ?? fetch;
  const injectEnabled = opts.inject !== false;
  const captureEnabled = opts.captureEnabled === true;

  return http.createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      // Last-resort guard: an exception anywhere in the handler must
      // still produce a response, never a hung connection. This is the
      // same 502 contract as an unreachable upstream, since by the time
      // we are here we can no longer promise a clean forward.
      if (!res.headersSent) {
        sendJson(res, 502, { "x-klio-proxy-error": messageOf(err), "x-klio-injected": "0" }, {
          type: "error",
          error: { type: "api_error", message: messageOf(err) },
        });
      } else {
        res.destroy();
      }
    });
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const rawUrl = req.url ?? "/";

    if (req.method === "GET" && new URL(rawUrl, "http://internal.invalid").pathname === PROXY_HEALTH_PATH) {
      sendJson(res, 200, {}, { status: "ok" });
      return;
    }

    const upstream = resolveUpstream(rawUrl, upstreams);
    if (!upstream.ok) {
      sendJson(res, 404, { "x-klio-injected": "0" }, {
        type: "error",
        error: { type: "not_found_error", message: "unknown upstream" },
      });
      return;
    }

    const body = await readRequestBody(req);
    const upstreamUrl = `${upstream.base}${upstream.path}${upstream.search}`;

    const isMessagesCall =
      !body.capped &&
      injectEnabled &&
      req.method === "POST" &&
      upstream.path.endsWith("/messages") &&
      opts.config !== null;

    let outBody: Buffer | Readable;
    let injected = 0;
    let originalBuffered: Buffer | null = null;

    if (body.capped) {
      outBody = body.stream;
    } else {
      originalBuffered = body.body;
      outBody = body.body;

      if (isMessagesCall) {
        let memories: Memory[] = [];
        try {
          const parsed: unknown = JSON.parse(body.body.toString("utf8"));
          const query = lastUserMessageText(parsed);
          memories = await recall(query);
        } catch {
          memories = [];
        }
        const result = injectMemories(body.body, memories);
        outBody = result.body;
        injected = result.injected;
      }
    }

    const headers = filterRequestHeaders(req.headers);
    const hasBody = Buffer.isBuffer(outBody) ? outBody.length > 0 : true;
    if (Buffer.isBuffer(outBody) && outBody.length > 0) {
      headers["content-length"] = String(outBody.length);
    }

    const init: RequestInit & { duplex?: "half" } = { method: req.method, headers };
    if (hasBody) {
      init.body = outBody as unknown as RequestInit["body"];
      init.duplex = "half";
    }

    let upstreamResponse: Response;
    try {
      upstreamResponse = await doFetch(upstreamUrl, init);
    } catch (err) {
      sendJson(
        res,
        502,
        { "x-klio-proxy-error": messageOf(err), "x-klio-injected": String(injected) },
        { type: "error", error: { type: "api_error", message: messageOf(err) } },
      );
      return;
    }

    const responseHeaders = filterResponseHeaders(upstreamResponse.headers);
    responseHeaders["x-klio-injected"] = String(injected);
    res.writeHead(upstreamResponse.status, responseHeaders);

    if (!upstreamResponse.body) {
      res.end();
      return;
    }

    const willCapture = captureEnabled && isMessagesCall && originalBuffered !== null && opts.config !== null;
    const upstreamNodeStream = Readable.fromWeb(
      upstreamResponse.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
    );

    if (!willCapture) {
      upstreamNodeStream.pipe(res);
      return;
    }

    const tee = new CapturingTee();
    const config = opts.config as CloudConfig;
    const requestBody = originalBuffered as Buffer;
    res.on("finish", () => {
      const assistantText = extractAssistantText(tee.captured(), responseHeaders["content-type"]);
      // Fire-and-forget, strictly after the response has been sent.
      void capture({
        config,
        agent: config.agentId,
        requestBody,
        assistantText,
        fetchImpl: doFetch,
      }).catch(() => {
        // Best-effort by contract; a capture failure must never surface
        // after the response has already been delivered.
      });
    });

    upstreamNodeStream.pipe(tee).pipe(res);
  }
}

export type StartProxyOptions = Omit<CreateProxyServerOptions, "config" | "recall"> & {
  port?: number;
  host?: string;
};

export async function startProxy(
  opts: StartProxyOptions = {},
): Promise<{ server: http.Server; port: number }> {
  const config = readCloudConfig();
  const inject = process.env["KLIO_PROXY_INJECT"] === "false" ? false : (opts.inject ?? true);
  const captureEnabled =
    process.env["KLIO_PROXY_CAPTURE"] === "false"
      ? false
      : (opts.captureEnabled ?? process.env["KLIO_PROXY_CAPTURE"] === "true");

  const recall = config ? createRecaller({ config, fetchImpl: opts.fetchImpl }) : undefined;

  const server = createProxyServer({
    config,
    upstreams: opts.upstreams,
    recall,
    capture: opts.capture,
    fetchImpl: opts.fetchImpl,
    inject,
    captureEnabled,
  });

  const port = opts.port ?? PROXY_PORT;
  const host = opts.host ?? PROXY_HOST;

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return { server, port };
}
