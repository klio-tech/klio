// Klio Cloud client primitives shared by the cloud-mode `klio init`
// flow (src/commands/initCloud.ts) and the cloud agent wiring
// (src/commands/wireCloudAgents.ts).
//
// Cloud mode points the user's AI agents at a hosted Klio brain — a
// remote MCP server reachable over Streamable HTTP — instead of the
// local Docker stack. The only secret the user supplies is an API key
// (the `X-Vex-Key` header), which doubles as their auth; there's no
// account provisioning, no engine, no containers.
//
// Pure-orchestration: every network call routes through an injectable
// `fetchFn` so the unit suite can drive these helpers hermetically.
// No module-level mutable state, no process.exit.

import { hostname } from "node:os";

/**
 * The hosted Streamable-HTTP MCP endpoint. Agents connect here over
 * HTTP (not stdio) once wired in cloud mode. Carries the user's
 * `X-Vex-Key` (auth) and `X-Vex-Agent` (stable per-machine id) on
 * every request.
 */
export const CLOUD_MCP_URL = "https://mcp.klio.tech/mcp";

/**
 * Key-verification endpoint. `GET` with header `X-Vex-Key: <key>`
 * returns:
 *   - 200 `{"valid":true,"org_id":...,"scopes":[...]}` when the key is
 *     valid AND carries the `memory` scope.
 *   - 401 when the key is missing or invalid.
 *   - 403 when the key is valid but lacks the `memory` scope.
 *
 * We rely on status + (optionally) `org_id` only — never on the rest
 * of the body shape.
 */
export const CLOUD_VERIFY_URL = "https://mcp.klio.tech/verify";

/** Header carrying the user's API key (auth) on every cloud request. */
export const VEX_KEY_HEADER = "X-Vex-Key";

/** Header carrying the stable per-machine agent id on every cloud request. */
export const VEX_AGENT_HEADER = "X-Vex-Agent";

/**
 * Outcome of `verifyCloudKey`. Tagged so the caller (initCloud) can
 * branch on the four cases without re-inspecting the HTTP Response:
 *
 *   - `valid`         — key works and has the `memory` scope. Proceed.
 *   - `missing_scope` — key authenticates but can't reach the brain
 *                       (403). The user must mint a key with the
 *                       `memory` scope.
 *   - `invalid`       — key rejected (401 or any other non-200/403
 *                       status). Re-prompt.
 *   - `network_error` — the fetch itself threw (DNS, ECONNREFUSED,
 *                       TLS). Never crashes the caller; surfaces the
 *                       message so init can offer retry/abort.
 */
export type VerifyKeyResult =
  | { kind: "valid"; orgId?: string }
  | { kind: "missing_scope" }
  | { kind: "invalid"; status: number }
  | { kind: "network_error"; message: string };

/**
 * Verify an API key against the hosted brain.
 *
 * Issues `GET CLOUD_VERIFY_URL` with the `X-Vex-Key` header and maps
 * the response to a `VerifyKeyResult`. Never throws — a transport
 * failure resolves to `network_error` so the interactive caller can
 * offer a clean retry rather than crashing onboarding.
 *
 * The `org_id` (when present in a 200 body) is surfaced so init can
 * show the user which org they connected to; everything beyond status
 * + org_id is ignored by design.
 */
export async function verifyCloudKey(
  key: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<VerifyKeyResult> {
  let res: Response;
  try {
    res = await fetchFn(CLOUD_VERIFY_URL, {
      method: "GET",
      headers: { [VEX_KEY_HEADER]: key },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "network_error", message };
  }

  if (res.status === 200) {
    const orgId = await extractOrgId(res);
    return { kind: "valid", ...(orgId ? { orgId } : {}) };
  }
  if (res.status === 403) {
    return { kind: "missing_scope" };
  }
  // 401 and any other non-success status collapse to "invalid" — the
  // user-facing message differentiates only between "no memory scope"
  // (403) and "key rejected" (everything else), per the endpoint
  // contract.
  return { kind: "invalid", status: res.status };
}

/**
 * Best-effort pull of `org_id` from a 200 verify body. Returns
 * undefined on any parse failure — the body is informational only,
 * never load-bearing, so a malformed payload must not derail a
 * successful verification.
 */
async function extractOrgId(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as unknown;
    if (
      body !== null &&
      typeof body === "object" &&
      "org_id" in body &&
      (body as { org_id?: unknown }).org_id != null
    ) {
      return String((body as { org_id: unknown }).org_id);
    }
  } catch {
    /* body absent or not JSON — org_id is optional */
  }
  return undefined;
}

/**
 * Derive a stable per-machine agent id from the host name, used as the
 * `X-Vex-Agent` header value. Deterministic from `os.hostname()` so
 * re-running `klio init` on the same machine produces the same id and
 * the hosted brain can correlate this machine's sessions across runs.
 *
 * Sanitization keeps the value header-safe and readable:
 *   - lowercase
 *   - any run of characters outside [a-z0-9] collapses to a single `-`
 *   - leading/trailing `-` trimmed
 *   - capped at 63 chars after the `klio-` prefix (DNS-label-ish, safe
 *     for any downstream that treats it like a hostname token)
 *
 * Falls back to `klio-unknown` when the host name sanitizes to empty
 * (e.g. a hostname of only punctuation) so the header is never blank.
 */
export function deriveAgentId(host: string = hostname()): string {
  const sanitized = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return sanitized ? `klio-${sanitized}` : "klio-unknown";
}

/**
 * Mask an API key for display — shows only the last 4 characters so a
 * key never lands in scrollback or logs in full. Short keys (≤4 chars)
 * are fully masked since there's nothing safe to reveal.
 */
export function maskKey(key: string): string {
  if (key.length <= 4) return "••••";
  return "••••" + key.slice(-4);
}
