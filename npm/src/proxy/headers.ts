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

export function filterResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lowered = name.toLowerCase();
    // content-length is dropped: the body is streamed, and a stale
    // length on a re-chunked response is worse than none.
    if (HOP_BY_HOP.has(lowered) || lowered === "content-length") return;
    out[lowered] = value;
  });
  return out;
}
