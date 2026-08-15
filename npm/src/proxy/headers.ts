// Header filtering for the local proxy, ported from
// proxy/src/klio_proxy/headers.py.
//
// A DENY list, never an allow list. An allow list silently drops the
// header Anthropic adds next month; a deny list forwards it. The cost
// of forwarding one header we did not anticipate is nothing; the cost
// of dropping `anthropic-ratelimit-*` is an agent that cannot back off.

/** Connection-scoped headers that must not cross a proxy hop (RFC 9110). */
export const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection", // non-standard but widely emitted
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Headers meaningful only to the hop the client opened. `host` must be
 * recomputed for the upstream; `content-length` is recomputed because
 * injection can change the body length.
 */
const REQUEST_ONLY_DROPS: ReadonlySet<string> = new Set(["host", "content-length"]);

export function filterRequestHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lowered = name.toLowerCase();
    if (HOP_BY_HOP.has(lowered) || REQUEST_ONLY_DROPS.has(lowered)) continue;
    out[lowered] = Array.isArray(value) ? (value[0] ?? "") : value;
  }
  return out;
}

/**
 * Response headers dropped for the same reason as `content-length`:
 * they describe bytes that no longer match what the client will
 * actually receive.
 *
 * `content-encoding` is the sharp one — `fetch` (undici) transparently
 * DECOMPRESSES a gzip/br/deflate upstream body before we ever see it,
 * but leaves the header on the `Response` object untouched. Forwarding
 * it verbatim tells the client "this body is still gzipped" when it is
 * plaintext; any client that honours the header (Node's own `http`,
 * another `fetch`, `curl --compressed`, `requests`) fails to decode a
 * body that was never actually compressed on the wire it received.
 * `content-range` is dropped for the same class of reason: it describes
 * a byte range of the ORIGINAL body, which is meaningless once the body
 * has been decompressed and re-streamed.
 */
const RESPONSE_ONLY_DROPS: ReadonlySet<string> = new Set(["content-length", "content-encoding", "content-range"]);

export function filterResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lowered = name.toLowerCase();
    if (HOP_BY_HOP.has(lowered) || RESPONSE_ONLY_DROPS.has(lowered)) return;
    out[lowered] = value;
  });
  return out;
}
