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
import type { AddressInfo } from "node:net";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

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

/**
 * A dead connection's `"close"`/`"aborted"`/`"error"` do not reliably
 * fire on a PAUSED `IncomingMessage` at all — confirmed against a bare
 * `http.Server` with zero proxy code involved, listeners attached as
 * early as possible: Node only notices the socket is gone while
 * actually attempting to read from it, and this class necessarily
 * pauses `live` while relaying to a downstream that cannot keep up
 * (see {@link BufferedThenLive} below). Resuming periodically to force
 * a read attempt was tried and measured unreliable — under sustained
 * backpressure (a slow downstream, a fast client) it could take
 * several SECONDS to line up, because each resume's very next
 * `"data"` immediately re-triggers the pause before Node's socket
 * layer gets a turn.
 *
 * `live.socket.setTimeout()` sidesteps this entirely: it is a libuv
 * idle timer on the SOCKET, independent of whether the higher-level
 * stream is paused or flowing, and Node resets it automatically on any
 * read/write activity. Confirmed against a bare socket: this timer
 * itself fires within single-digit milliseconds of a real RST,
 * regardless of pause state — but see `connection: close` below for
 * why detection firing is not the whole story once `undici`'s
 * connection pooling is in the picture.
 *
 * The value trades two failure modes against each other: too low false-
 * positives a real, if slow, upload (killing a live connection because
 * it was merely quiet for a moment); too high leaves a dead connection
 * relaying to the upstream for that much longer. 2s is generous enough
 * that any connection actually still sending SOMETHING within that
 * window is left alone (Claude Code's own upload pacing, and any
 * ordinary network jitter, comfortably clears it).
 *
 * End-to-end (this timer firing, THROUGH this stream's `.destroy()`,
 * THROUGH `undici` actually tearing the socket to the upstream down —
 * see the `connection: close` header set for the over-cap path in
 * `handleRequest`) measured at roughly 6-8s under an adversarial
 * combination (a large buffered prefix, a slow-reading upstream, and a
 * genuinely still-uploading client) in this codebase's own tests —
 * NOT the single-digit milliseconds the timer alone achieves in
 * isolation. Still a dramatic, bounded improvement over the prior
 * behavior (unbounded in practice; reaped only by Node's multi-minute
 * default `server.requestTimeout`), just not an instant one — `undici`
 * pooling a keep-alive connection for reuse means an abort has to
 * propagate through more than this one timer to actually free the
 * socket. `connection: close` (below) is what makes that propagation
 * happen at all rather than never; it does not make it instant.
 */
const LIVE_IDLE_TIMEOUT_MS = 2000;

/**
 * A Readable that replays `prefix` (already-buffered chunks) first,
 * then relays the still-live `live` stream once the prefix is drained.
 *
 * This has to be a BRAND NEW Readable, not `live` itself handed onward.
 * `live` (the request's `IncomingMessage`) has necessarily already had
 * data read from it by the time the cap is detected — that IS how the
 * cap is detected — and `undici`'s `fetch` refuses any Node Readable
 * whose `readableDidRead` is already `true`, throwing "Response body
 * object should not be disturbed or locked". `req.unshift()` puts the
 * bytes back on the read queue, but it cannot clear that flag.
 * Confirmed: handing `req` itself onward made every over-cap request
 * fail instantly with that error and forward zero bytes, never
 * reaching the upstream. Wrapping in a fresh `Readable` — which has
 * never been read from — sidesteps the check entirely.
 *
 * Two lifecycle details matter as much as the byte-forwarding itself:
 *
 *   * `live`'s `"end"`/`"close"`/`"aborted"`/`"error"` listeners, AND
 *     the idle timeout above, are wired in the CONSTRUCTOR — not
 *     lazily inside `_read()`, which left `live` with ZERO
 *     supervision for however long the buffered prefix took to drain.
 *   * `_destroy()` tears `live` down too. Without it, destroying this
 *     wrapper (the upstream fetch rejects, or `undici` cancels the
 *     request body after an early response) leaves `live` neither
 *     destroyed nor resumed — its still-registered `"data"` handler
 *     keeps pushing into an already-destroyed stream, `push()` returns
 *     `false`, `live.pause()`s, and the client's socket sits open with
 *     an undrained body until Node's ~5-minute default request timeout
 *     reaps it. Confirmed against an upstream that responds (e.g. 413)
 *     without ever reading the body.
 */
class BufferedThenLive extends Readable {
  private liveEnded = false;
  private liveAttached = false;
  private readonly onLiveData: (chunk: Buffer) => void;
  private readonly onLiveEnd: () => void;
  private readonly onLiveClose: () => void;
  private readonly onLiveAborted: () => void;
  private readonly onLiveError: (err: Error) => void;
  private readonly onLiveTimeout: () => void;

  constructor(
    private readonly prefix: Buffer[],
    private readonly live: http.IncomingMessage,
  ) {
    super();

    this.onLiveData = (chunk: Buffer): void => {
      if (!this.push(chunk)) this.live.pause();
    };
    // "end" is the clean-completion path — in paused mode it only
    // fires once all buffered data has actually been consumed via a
    // read. "close" covers what "end" does not: an aborted request
    // commonly emits "close" (and "aborted") with NO "error" at all. A
    // `live` that closes abnormally must still end this stream, or it
    // hangs forever — no `null` ever pushed, nothing destroyed, and
    // the upstream fetch body this feeds never completes.
    this.onLiveEnd = (): void => this.finishLive();
    this.onLiveClose = (): void => this.finishLive();
    this.onLiveAborted = (): void => {
      this.destroy(new Error("client aborted mid-upload"));
    };
    this.onLiveError = (err: Error): void => {
      this.destroy(err);
    };
    this.onLiveTimeout = (): void => {
      if (this.liveEnded || this.destroyed) return;
      this.destroy(new Error(`client idle for ${LIVE_IDLE_TIMEOUT_MS}ms mid-upload`));
    };

    this.live.on("end", this.onLiveEnd);
    this.live.on("close", this.onLiveClose);
    this.live.on("aborted", this.onLiveAborted);
    this.live.on("error", this.onLiveError);
    this.live.socket?.setTimeout(LIVE_IDLE_TIMEOUT_MS, this.onLiveTimeout);
  }

  private finishLive(): void {
    if (this.liveEnded) return;
    this.liveEnded = true;
    this.push(null);
  }

  override _read(): void {
    while (this.prefix.length > 0) {
      const chunk = this.prefix.shift() as Buffer;
      if (!this.push(chunk)) return;
    }
    if (!this.liveAttached) {
      this.liveAttached = true;
      this.live.on("data", this.onLiveData);
    }
    this.live.resume();
  }

  override _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    this.detachFromLive();
    this.live.destroy(err ?? undefined);
    callback(err);
  }

  /**
   * Stop relaying `live` into this wrapper and let it drain on its own,
   * WITHOUT destroying it — used instead of `.destroy()` when the
   * proxy is done with this wrapper because ITS OWN response already
   * went out, not because the client went away.
   *
   * `live` shares its socket with `res`. Calling `.destroy()` here —
   * even after `res`'s `"finish"` event, i.e. after the response has
   * been fully handed to the OS — still tears down that shared socket
   * while the client may still be mid-upload, and a duplex socket
   * killed with data still arriving on it commonly surfaces to the
   * CLIENT as a raw `ECONNRESET`/`EPIPE`, not a clean read of the
   * response we already sent. Confirmed: even gating `.destroy()` on
   * `res`'s `"finish"` event, the client's own `fetch()` call still
   * failed outright instead of receiving the 502 the proxy had already
   * queued — worse than the resource leak it was meant to fix.
   *
   * Removing our own `"data"` listener and resuming `live` lets Node's
   * own default behavior take over: with nobody consuming it, a
   * flowing stream's data is simply discarded, exactly as if this
   * proxy had never touched `req` at all (see `debug`-verified
   * behavior of a plain `http.Server` under the same scenario). The
   * connection drains at whatever pace the client sends and is then
   * free for Node's own normal keep-alive/idle handling — bounded by
   * the client's own upload time, not "forever", and without any risk
   * to the response already delivered.
   */
  abandon(): void {
    this.detachFromLive();
    this.live.resume();
  }

  private detachFromLive(): void {
    this.live.removeListener("data", this.onLiveData);
    this.live.removeListener("end", this.onLiveEnd);
    this.live.removeListener("close", this.onLiveClose);
    this.live.removeListener("aborted", this.onLiveAborted);
    this.live.removeListener("error", this.onLiveError);
    this.live.socket?.removeListener("timeout", this.onLiveTimeout);
  }
}

/**
 * Read the request body, capped at {@link MAX_REQUEST_BODY_BYTES}.
 *
 * Deliberately event-based, NOT `for await...of req`. Exiting an async
 * iterator early (`return`/`break` out of `for await`) calls the
 * iterator's `.return()`, which for a Node stream DESTROYS it. A
 * destroyed `req` can never emit `"end"`, so anything downstream still
 * waiting to read the rest of the body — a hand-off stream, a proxied
 * fetch — hangs forever. Confirmed: an >10MB POST would never complete
 * with the iterator version.
 *
 * Instead: read via plain `"data"`/`"end"` listeners, and on crossing
 * the cap, hand a {@link BufferedThenLive} onward — the bytes already
 * read, followed by the rest of the live socket. The stream is never
 * exited early, never destroyed, and the caller sees one continuous
 * byte stream with nothing lost or duplicated, wrapped in a Readable
 * `fetch` has never seen before.
 */
function readRequestBody(
  req: http.IncomingMessage,
): Promise<{ capped: false; body: Buffer } | { capped: true; stream: BufferedThenLive }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    function cleanup(): void {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
    }

    function onData(raw: Buffer): void {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      total += chunk.length;
      chunks.push(chunk);
      if (settled) return;

      if (total > MAX_REQUEST_BODY_BYTES) {
        settled = true;
        cleanup();
        req.pause();
        // Hand off the SAME array, not a copy: `onData` is already
        // unreachable from `req` after `cleanup()` above and will never
        // push to `chunks` again (guarded by `settled`), so nothing
        // else needs its own reference to these buffers. A `.slice()`
        // copy here would pin the same ~10 MB of Buffer objects a
        // second time for as long as this closure scope survives —
        // benign for one request, a real transient-memory floor under
        // a burst of concurrent over-cap requests.
        resolve({ capped: true, stream: new BufferedThenLive(chunks, req) });
      }
    }

    function onEnd(): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ capped: false, body: Buffer.concat(chunks, total) });
    }

    function onError(err: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
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

const FALSY_ENV_VALUES = new Set(["false", "0", "no", "off"]);
const TRUTHY_ENV_VALUES = new Set(["true", "1", "yes", "on"]);

/** Accepts the common spellings of "off" for a boolean env var — not just the literal string `"false"`. */
function envIsFalsy(value: string | undefined): boolean {
  return value !== undefined && FALSY_ENV_VALUES.has(value.trim().toLowerCase());
}

/** Accepts the common spellings of "on" for a boolean env var. */
function envIsTruthy(value: string | undefined): boolean {
  return value !== undefined && TRUTHY_ENV_VALUES.has(value.trim().toLowerCase());
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
      // Last-resort guard, not the primary error path: every step below
      // (recall, injectMemories, the upstream fetch) is independently
      // try/catch-guarded and degrades on its own. This only fires for
      // a bug in the handler itself — a place we did not anticipate
      // needing a guard. Even then, a response must still go out rather
      // than leave the connection hanging, so it uses the same 502
      // shape as a genuinely unreachable upstream.
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

    // Shape predicate ONLY — "is this a request injection and capture
    // could apply to at all". Deliberately independent of `injectEnabled`:
    // `KLIO_PROXY_INJECT` and `KLIO_PROXY_CAPTURE` are two separate
    // user-facing toggles, and someone disabling injection (most likely
    // because they suspect it of affecting model output) must not also
    // silently lose capture with no signal that it happened.
    const isMessagesShape =
      !body.capped && req.method === "POST" && upstream.path.endsWith("/messages") && opts.config !== null;
    const willInject = isMessagesShape && injectEnabled;

    let outBody: Buffer | Readable;
    let injected = 0;
    let originalBuffered: Buffer | null = null;

    // Tracked separately from `outBody` so it stays reachable regardless
    // of which branch below reassigns `outBody`. `undici` does NOT
    // reliably call `.destroy()` (or anything else) on an abandoned
    // half-duplex request body on its own (confirmed empirically:
    // waited 20s+ against both an immediately-unreachable upstream and
    // an upstream that responds before ever reading the body — it
    // never did), so the proxy has to release it explicitly once this
    // request is done, one way or another. See the `res.on(...)`
    // wiring below for WHEN, and `BufferedThenLive.abandon()` for WHY
    // that is `abandon()` and not `.destroy()` on the common path.
    const capStream: BufferedThenLive | null = body.capped ? body.stream : null;

    // `"finish"`: the response was delivered normally — the client may
    // still be mid-upload of the (over-cap) body, so release `capStream`
    // via `abandon()` (drain and discard, socket left alone) rather than
    // `.destroy()` (tears down the shared socket, which risked the
    // client's own `fetch()` failing with `ECONNRESET` instead of
    // cleanly receiving the response already sent — confirmed even when
    // gated on this exact `"finish"` event).
    //
    // `"close"`: the underlying connection is already gone — most often
    // because the CLIENT went away (Finding 1's scenario). There is no
    // response left to protect, so a real `.destroy()` here is both
    // safe and correct; it also catches the failure-path exit below,
    // which `pipeline()` settles by destroying `res` rather than a
    // graceful `.end()` (no `"finish"` in that case).
    let capStreamSettled = false;
    res.on("finish", () => {
      if (capStreamSettled) return;
      capStreamSettled = true;
      capStream?.abandon();
    });
    res.on("close", () => {
      if (capStreamSettled) return;
      capStreamSettled = true;
      capStream?.destroy();
    });

    if (body.capped) {
      outBody = body.stream;
    } else {
      originalBuffered = body.body;
      outBody = body.body;

      if (willInject) {
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
    if (capStream) {
      // Over the body cap only: `undici` POOLS keep-alive connections
      // for reuse, and — confirmed by direct instrumentation — that
      // pooling means aborting the request (destroying the body stream,
      // or an AbortController) does NOT promptly close the underlying
      // socket; it just sits in the pool, un-torn-down, and the
      // UPSTREAM's own view of the connection stays open regardless of
      // anything this proxy does afterward. `connection: close` on the
      // outgoing request opts this one exchange out of pooling, which
      // is what actually lets an abort tear the socket down —
      // confirmed: with it, the upstream saw the close within
      // single-digit milliseconds of the abort; without it, never
      // observed within several seconds. Scoped to the over-cap path
      // only — paying a fresh TLS handshake on every ordinary request
      // would be a real latency cost this proxy sits directly in the
      // path of, and the failure mode this fixes only exists for
      // large, capped bodies in the first place.
      headers["connection"] = "close";
    }

    const init: RequestInit & { duplex?: "half" } = { method: req.method, headers };
    if (hasBody) {
      init.body = outBody as unknown as RequestInit["body"];
      init.duplex = "half";
    }

    // The `res.on("finish"/"close", ...)` wiring above is the ONLY
    // place `capStream` is released in the ordinary case — deliberately not
    // repeated here in a `finally`. A `finally` right after this block
    // runs synchronously as part of unwinding on `return`, i.e. in the
    // very same tick as `sendJson`/`res.end()` — before the underlying
    // write has actually reached the OS, let alone the client. Doing
    // the destroy there raced ahead of the client still reading the
    // response: confirmed against a fast-failing upstream, where the
    // client's own `fetch()` failed with `ECONNRESET` instead of
    // cleanly receiving the 502 the proxy had already queued. Every
    // exit path below ends by calling `res.end()` (directly, or via
    // `pipeline()`), which always eventually fires `"finish"` or
    // `"close"` — so nothing here needs its own fallback.
    try {
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

      const willCapture = captureEnabled && isMessagesShape && originalBuffered !== null && opts.config !== null;
      const upstreamNodeStream = Readable.fromWeb(
        upstreamResponse.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
      );

      // `pipeline()`, never bare `.pipe()`. Two failure modes this covers
      // together, both reproduced against the plain-`.pipe()` version:
      //
      //   * The upstream connection resets mid-stream (an ordinary TLS
      //     reset on a long SSE response — exactly what api.anthropic.com
      //     does under normal operation). `.pipe()` does not forward
      //     source errors to the destination; an unhandled "error" on an
      //     EventEmitter with no listener crashes the process.
      //   * The client disconnects mid-stream (Claude Code aborts on ESC
      //     or tool-loop cancellation, constantly). `.pipe()` does not
      //     destroy the source on a destination close, so the upstream
      //     fetch — and the tokens it's billing — keeps running with
      //     nobody reading it. `pipeline()` detects the premature close
      //     and destroys every stream in the chain, which for
      //     `Readable.fromWeb` propagates into `reader.cancel()` on the
      //     underlying web stream.
      //
      // Either way, by the time `pipeline` rejects, headers are already
      // sent and the response may be partially flushed — there is no
      // clean response left to send, so the rejection is swallowed here
      // rather than bubbling to the last-resort handler above.
      if (!willCapture) {
        try {
          await pipeline(upstreamNodeStream, res);
        } catch {
          // Client aborted or upstream reset mid-stream; already handled
          // by pipeline() destroying both ends. Nothing left to forward.
        }
        return;
      }

      const tee = new CapturingTee();
      const config = opts.config as CloudConfig;
      const requestBody = originalBuffered as Buffer;
      res.on("finish", () => {
        // Guards a SYNCHRONOUS throw from `capture` (a public injection
        // point a caller could hand us a broken implementation of), not
        // just a rejected promise — a throw here happens after the
        // response has already been delivered and must never surface.
        try {
          const assistantText = extractAssistantText(tee.captured(), responseHeaders["content-type"]);
          void capture({
            config,
            agent: config.agentId,
            requestBody,
            assistantText,
            fetchImpl: doFetch,
          }).catch(() => {
            // Best-effort by contract; a capture failure must never
            // surface after the response has already been delivered.
          });
        } catch {
          // See above: a synchronous throw gets the same treatment.
        }
      });

      try {
        await pipeline(upstreamNodeStream, tee, res);
      } catch {
        // Same as the non-capture branch above.
      }
    } catch (err) {
      // Truly unexpected: nothing above threw past its own try/catch.
      // `res` may never have been written to at all in this case, so
      // there is no response to protect — destroy immediately rather
      // than wait on events that may never fire.
      if (!capStreamSettled) {
        capStreamSettled = true;
        capStream?.destroy();
      }
      throw err;
    }
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
  const injectEnv = process.env["KLIO_PROXY_INJECT"];
  const inject = envIsFalsy(injectEnv) ? false : (opts.inject ?? true);

  const captureEnv = process.env["KLIO_PROXY_CAPTURE"];
  const captureEnabled = envIsFalsy(captureEnv) ? false : (opts.captureEnabled ?? envIsTruthy(captureEnv));

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

  // `server.listen()` throws asynchronously via an "error" event (e.g.
  // EADDRINUSE), not via the listen callback or a rejected promise. With
  // no listener, that is an uncaught exception — confirmed: an occupied
  // port crashed the process before any caller could report "port 8787
  // is already in use". The one-shot listener below turns that into a
  // normal rejection for callers of `startProxy`; a permanent no-op
  // listener replaces it once listening succeeds, so a later transient
  // server-level error (e.g. EMFILE) can't crash the process either —
  // by that point the caller has already gotten its `{ server, port }`
  // and has no promise left to reject.
  await new Promise<void>((resolve, reject) => {
    const onStartupError = (err: unknown): void => reject(err instanceof Error ? err : new Error(String(err)));
    server.once("error", onStartupError);
    server.listen(port, host, () => {
      server.removeListener("error", onStartupError);
      resolve();
    });
  });
  server.on("error", () => {
    // Post-startup server-level errors have no caller left to report to.
  });

  // Report the ADDRESS ACTUALLY BOUND, not the requested port. With
  // `port: 0` (ephemeral — used by tests and anything that wants the OS
  // to pick a free port) the requested value is always 0; the caller
  // needs the real bound port to do anything useful with it.
  const bound = server.address() as AddressInfo | null;
  return { server, port: bound?.port ?? port };
}
