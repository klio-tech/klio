// Single source of truth for everything that names the proxy.
//
// The port appears in at least six places: the compose file, the
// container's published port, the ANTHROPIC_BASE_URL we write into
// ~/.claude/settings.json, the base_url we write into
// ~/.codex/config.toml, the supervisor unit, and `klio doctor`'s
// probes. If any one of them drifts, the symptom is an agent that
// cannot reach a model at all — and the cause is a number that
// disagrees with itself in a file the user never opens.
//
// So none of them hold a literal. They all import from here.

/**
 * Port the local proxy listens on. From the Klio Compression design
 * doc. Chosen to be memorable and outside the ranges agents and dev
 * servers usually squat on (3000, 5173, 8000, 8080).
 */
export const PROXY_PORT = 8787;

/**
 * The literal address the server binds. Loopback only, always — the
 * proxy forwards the user's Anthropic credentials on every request, so
 * binding anything other than the IPv4 loopback literal would turn a
 * local dev tool into an open relay for anyone who can route to the
 * machine. `127.0.0.1` rather than `localhost`: binding must not depend
 * on how the host's resolver happens to order `localhost`'s addresses.
 *
 * This is the BIND address; `PROXY_PROBE_URL` below is the same literal
 * used as the DIAL address — one config's socket, the other's a URL a
 * client requests. They have to agree for the same reason described
 * there: a resolver that prefers `::1` would otherwise make a
 * `127.0.0.1`-bound server look dead to a `localhost`-dialing client.
 */
export const PROXY_HOST = "127.0.0.1";

/**
 * Loopback only, always. The proxy forwards the user's Anthropic
 * credentials on every request; a proxy reachable from the local
 * network is an open relay for anyone who can route to the machine.
 *
 * `localhost` rather than `127.0.0.1` because that is the literal in
 * the design doc and what users will paste from the docs when
 * debugging. On hosts where `localhost` resolves to `::1` first, the
 * container's published `127.0.0.1:8787` would be unreachable — see
 * `PROXY_PROBE_URL`, which is what `klio doctor` actually dials.
 */
export const PROXY_BASE_URL = `http://localhost:${PROXY_PORT}`;

/**
 * The URL `klio doctor` and the supervisor probe. Pinned to the IPv4
 * literal because Docker publishes the port on `127.0.0.1` only: on a
 * machine that resolves `localhost` to `::1`, a health check against
 * `localhost` would report the proxy dead while it is serving traffic
 * perfectly well to any client that also falls back to IPv4.
 */
export const PROXY_PROBE_URL = `http://127.0.0.1:${PROXY_PORT}`;

/** Liveness endpoint. Namespaced so it can never shadow an API path. */
export const PROXY_HEALTH_PATH = "/__klio/health";

/**
 * The body {@link PROXY_HEALTH_PATH} returns, and the ONLY proof of
 * ownership anything in this CLI is allowed to act on before signalling
 * a process.
 *
 * A pid on its own is not proof: pids are recycled, and a health probe
 * that merely answers proves only that SOMETHING is bound to 8787. That
 * "something" may be the Python proxy in a container (whose pid lives in
 * another namespace — signalling it on the host would kill an unrelated
 * process), or a stray dev server, or a SURVIVOR of an earlier `klio
 * init` still serving with credentials that have since been rotated.
 *
 * So the body carries three discriminators:
 *
 *   * `runtime: "node"` — emitted only by this file's server. The Python
 *     proxy (proxy/src/klio_proxy/app.py) returns `status`, `upstream`,
 *     `upstreams` and `mode`, and no `runtime` or `pid`. Nothing may
 *     signal a pid read from a body without this field.
 *   * `pid` — the host pid to signal, valid precisely because `runtime`
 *     says the responder is a host process, not a container.
 *   * `config_fingerprint` — see `configFingerprint` in cloudConfig.ts.
 *     Lets `klio init` tell "the proxy I just started" from "a survivor
 *     holding the port with the key I just rotated away from".
 *
 * `mode` names the transforms that are actually live, so `klio proxy
 * status` can say what the proxy is DOING rather than "unknown mode".
 */
export type ProxyHealth = {
  status: "ok";
  mode: string;
  runtime: "node";
  pid: number;
  config_fingerprint: string;
};

/** Compose service name — used with `docker compose up/restart <svc>`. */
export const PROXY_SERVICE = "proxy";

/**
 * Container name — used with `docker exec` / `docker inspect`. Differs
 * from `PROXY_SERVICE` by the same convention as the rest of the stack
 * (`klio-<svc>` so all containers sort together in `docker ps`).
 */
export const PROXY_CONTAINER = "klio-proxy";

/**
 * Environment variables `klio init` writes into an agent's config, and
 * `klio uninit` removes.
 *
 * `ENABLE_TOOL_SEARCH` is NOT optional. Pointing ANTHROPIC_BASE_URL at
 * a non-Anthropic host disables MCP Tool Search by default — the
 * platform feature that cuts tool-schema tokens by ~85%. Without this
 * flag, routing through the proxy is a net token LOSS the user has no
 * way to see. The two keys are written together and removed together
 * for that reason; treating them as independent is how someone ends up
 * with the first without the second.
 */
export const CLAUDE_ENV_KEYS = ["ANTHROPIC_BASE_URL", "ENABLE_TOOL_SEARCH"] as const;

/** The exact env block `klio init` merges into ~/.claude/settings.json. */
export function claudeProxyEnv(): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: PROXY_BASE_URL,
    ENABLE_TOOL_SEARCH: "true",
  };
}
