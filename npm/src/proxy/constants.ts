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
