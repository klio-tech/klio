// Where `klio proxy serve` gets its port, host and upstream from.
//
// This exists because there was NO WAY to run the Node proxy anywhere
// but port 8787 against api.anthropic.com. `KLIO_PROXY_PORT` reaches
// only the Docker/Python proxy (compose.ts), `DEFAULT_UPSTREAMS` is a
// programmatic option on `createProxyServer` with no CLI or env path to
// it, and `serve()` called `startProxy({})`. The consequence showed up
// the first time anyone verified the proxy against a real model API:
// the run had to be done against a COPY OF THE BUILT ARTIFACT with two
// literals patched by hand (`dist/proxy/constants.js`'s port and
// `dist/proxy/server.js`'s upstream host), because this machine's 8787
// carries a live supervised proxy that must not be disturbed. A
// verification procedure that requires patching compiled output is one
// nobody will repeat, and "we could not test it in place" is how a
// defect like the inert-injection one survives.
//
// So both are real seams now, resolved with the ordinary precedence:
// explicit flag > environment > the shipped default.
//
// NOTE this affects `serve` only. `klio proxy status|ensure|stop` and
// `klio doctor` probe `PROXY_PROBE_URL`, which is pinned to 8787 by
// design (it is the port written into the agents' configs). Serving on
// another port is a verification and development affordance, not a
// second supported deployment.

import { PROXY_HOST, PROXY_PORT } from "./constants.js";

export type ServeOptions = {
  port: number;
  host: string;
  /** Only the upstreams that were overridden; merged over the defaults. */
  upstreams?: Record<string, string>;
};

export type ServeOptionsResult =
  | { ok: true; options: ServeOptions }
  | { ok: false; error: string };

/** Upstream names are map keys and appear in a URL path — keep them boring. */
const UPSTREAM_NAME = /^[a-z0-9][a-z0-9_-]*$/i;

function parsePort(raw: string, origin: string): number | string {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return `${origin} must be a number, got ${JSON.stringify(raw)}`;
  const value = Number(trimmed);
  // 0 is meaningful and allowed: it asks the OS for an ephemeral port,
  // which is what a test harness or a second local instance wants.
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    return `${origin} must be between 0 and 65535, got ${trimmed}`;
  }
  return value;
}

/**
 * Accepts `<url>` (overrides the default `anthropic` upstream) or
 * `<name>=<url>`. Rejects anything that is not an absolute http(s) URL:
 * this value ends up as the target of every forwarded request, so a
 * typo that silently resolved to something unexpected would send the
 * user's API credentials there.
 */
function parseUpstream(raw: string, origin: string, into: Record<string, string>): string | null {
  const spec = raw.trim();
  if (spec === "") return `${origin} must not be empty`;

  const eq = spec.indexOf("=");
  const looksNamed = eq > 0 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(spec);
  const name = looksNamed ? spec.slice(0, eq).trim() : "anthropic";
  const url = looksNamed ? spec.slice(eq + 1).trim() : spec;

  if (!UPSTREAM_NAME.test(name)) {
    return `${origin} has an invalid upstream name ${JSON.stringify(name)}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${origin} must be an absolute URL, got ${JSON.stringify(url)}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `${origin} must be http or https, got ${JSON.stringify(parsed.protocol)}`;
  }

  // Stored without a trailing slash: the server concatenates
  // `base + path`, and `https://host/` + `/v1/messages` would double it.
  into[name] = url.replace(/\/+$/, "");
  return null;
}

/**
 * Resolve `klio proxy serve`'s options from its arguments and the
 * environment. `args` is everything after `serve`.
 *
 * Never throws: an unusable value is returned as an error string for
 * the caller to print, because a proxy that starts somewhere the user
 * did not ask for is worse than one that refuses to start.
 */
export function resolveServeOptions(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ServeOptionsResult {
  const upstreams: Record<string, string> = {};
  let port: number | undefined;
  let host: string | undefined;

  // Environment first, so an explicit flag can override it below.
  const envPort = env["KLIO_PROXY_PORT"];
  if (envPort !== undefined && envPort.trim() !== "") {
    const parsed = parsePort(envPort, "KLIO_PROXY_PORT");
    if (typeof parsed === "string") return { ok: false, error: parsed };
    port = parsed;
  }

  const envHost = env["KLIO_PROXY_HOST"];
  if (envHost !== undefined && envHost.trim() !== "") host = envHost.trim();

  const envUpstream = env["KLIO_PROXY_UPSTREAM"];
  if (envUpstream !== undefined && envUpstream.trim() !== "") {
    for (const spec of envUpstream.split(",")) {
      if (spec.trim() === "") continue;
      const error = parseUpstream(spec, "KLIO_PROXY_UPSTREAM", upstreams);
      if (error !== null) return { ok: false, error };
    }
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const eq = arg.indexOf("=");
    const flag = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith("--") && eq > 0 ? arg.slice(eq + 1) : undefined;

    if (flag !== "--port" && flag !== "--host" && flag !== "--upstream") {
      if (arg.startsWith("--")) return { ok: false, error: `unknown option ${arg}` };
      continue;
    }

    const value = inline ?? args[++i];
    if (value === undefined) return { ok: false, error: `${flag} needs a value` };

    if (flag === "--port") {
      const parsed = parsePort(value, "--port");
      if (typeof parsed === "string") return { ok: false, error: parsed };
      port = parsed;
    } else if (flag === "--host") {
      if (value.trim() === "") return { ok: false, error: "--host needs a value" };
      host = value.trim();
    } else {
      const error = parseUpstream(value, "--upstream", upstreams);
      if (error !== null) return { ok: false, error };
    }
  }

  return {
    ok: true,
    options: {
      port: port ?? PROXY_PORT,
      host: host ?? PROXY_HOST,
      ...(Object.keys(upstreams).length > 0 ? { upstreams } : {}),
    },
  };
}
