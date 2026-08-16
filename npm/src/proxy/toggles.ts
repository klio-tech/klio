// The proxy's two kill switches, and where they LIVE.
//
// `KLIO_PROXY_CAPTURE` is the user's only control over whether their
// conversations leave the machine. An environment variable alone cannot
// carry that promise, and shipping it as if it could was a consent bug,
// not a papercut:
//
//   `startProxy` reads `process.env` exactly once at boot, and the only
//   deployment `klio init` produces is a SUPERVISED one — launchd or
//   systemd runs `klio proxy ensure`, which spawns the proxy as its own
//   child. That child inherits the SUPERVISOR's environment, never the
//   user's shell. So `export KLIO_PROXY_CAPTURE=off` + restart visibly
//   worked, and the next reboot silently turned capture back on with no
//   signal at all. Reproduced with `env -i … proxy ensure`.
//
// Emitting the variables into the generated units was rejected as the
// primary fix: the unit is written once, at `klio init` time, from the
// environment that happened to be present then, so a decision the user
// makes LATER would still not be in it, and a decision they make in a
// shell would still be invisible to the supervisor.
//
// So the durable answer is the file the proxy already reads at boot:
// ~/.klio/config.json. Precedence, strongest first:
//
//   1. The environment of THIS process — `KLIO_PROXY_*`. Still the
//      documented way to override one run (`KLIO_PROXY_CAPTURE=off klio
//      proxy serve`), and it must keep beating the file or that
//      one-shot override stops working.
//   2. `proxy.{inject,capture}` in ~/.klio/config.json — written by
//      `klio proxy capture off` / `klio proxy inject off`, and what
//      survives a restart, a reboot, and a re-run of `klio init`.
//   3. On. Both halves are kill switches: present unless turned off.

import { readFileSync } from "node:fs";

import { cloudConfigPath, readConfigObject, writeConfigObject } from "../cloudConfig.js";

/** The two halves of what the proxy does to traffic. */
export type ProxyToggleName = "inject" | "capture";

/** Both toggle names, in the order they are printed. */
export const PROXY_TOGGLE_NAMES: readonly ProxyToggleName[] = ["inject", "capture"] as const;

/** The environment variable that overrides each toggle for one process. */
export const PROXY_TOGGLE_ENV: Readonly<Record<ProxyToggleName, string>> = {
  inject: "KLIO_PROXY_INJECT",
  capture: "KLIO_PROXY_CAPTURE",
};

/** One-line description of each half, for the CLI and for `--help`. */
export const PROXY_TOGGLE_DESCRIPTION: Readonly<Record<ProxyToggleName, string>> = {
  inject: "appending your team's Klio memories to the request's `system` field",
  capture: "sending conversations to Klio as grading evidence",
};

/** Where a resolved value came from — reported so the CLI can explain itself. */
export type ToggleSource = "env" | "config" | "default";

export type ResolvedToggle = { enabled: boolean; source: ToggleSource };

export type ResolvedProxyToggles = Record<ProxyToggleName, ResolvedToggle>;

/** What is written under `proxy` in the config file. Both keys optional. */
export type PersistedToggles = Partial<Record<ProxyToggleName, boolean>>;

const FALSY_ENV_VALUES = new Set(["false", "0", "no", "off"]);

/**
 * Accepts the common spellings of "off" for a boolean env var — not
 * just the literal string `"false"`.
 *
 * There is deliberately no `envIsTruthy` counterpart. Both toggles are
 * kill switches: on unless explicitly turned off. An "is it truthy"
 * test only ever appears when something is off by default, which for
 * these two is the bug, not the design. A variable set to the EMPTY
 * string is treated as unset — `export KLIO_PROXY_CAPTURE=` is a
 * mistake, not an instruction, and reading it as "on" would silently
 * override a persisted opt-out.
 */
export function envIsFalsy(value: string | undefined): boolean {
  return value !== undefined && FALSY_ENV_VALUES.has(value.trim().toLowerCase());
}

export type ResolveTogglesOptions = {
  /** Defaults to this process's environment. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to ~/.klio/config.json. */
  configPath?: string;
  /** Pre-read persisted values, for callers that already have them. */
  persisted?: PersistedToggles;
};

/**
 * Read `proxy.{inject,capture}` out of the config file.
 *
 * NEVER throws and never partially trusts: a missing file, unreadable
 * file, malformed JSON, a `proxy` key that is not an object, or a value
 * that is not a real boolean all read as "nothing persisted", which
 * falls through to the on-by-default contract. A string `"off"` is NOT
 * accepted here on purpose — this file is written by `klio proxy
 * capture off`, not hand-edited, and quietly interpreting hand-typed
 * strings would make the file's meaning depend on spelling.
 */
export function readPersistedToggles(path: string = cloudConfigPath()): PersistedToggles {
  const parsed = readConfigObject(path);
  if (parsed === null) return {};

  const proxy = parsed["proxy"];
  if (proxy === null || typeof proxy !== "object" || Array.isArray(proxy)) return {};

  const toggles: PersistedToggles = {};
  for (const name of PROXY_TOGGLE_NAMES) {
    const value = (proxy as Record<string, unknown>)[name];
    if (typeof value === "boolean") toggles[name] = value;
  }
  return toggles;
}

/** Resolve one toggle. See the module docblock for the precedence rule. */
export function resolveProxyToggle(
  name: ProxyToggleName,
  opts: ResolveTogglesOptions = {},
): ResolvedToggle {
  const env = opts.env ?? process.env;
  const raw = env[PROXY_TOGGLE_ENV[name]];
  if (raw !== undefined && raw.trim() !== "") {
    return { enabled: !envIsFalsy(raw), source: "env" };
  }

  const persisted = opts.persisted ?? readPersistedToggles(opts.configPath);
  const stored = persisted[name];
  if (typeof stored === "boolean") return { enabled: stored, source: "config" };

  return { enabled: true, source: "default" };
}

/** Resolve both toggles, reading the config file at most once. */
export function resolveProxyToggles(opts: ResolveTogglesOptions = {}): ResolvedProxyToggles {
  const persisted = opts.persisted ?? readPersistedToggles(opts.configPath);
  return {
    inject: resolveProxyToggle("inject", { ...opts, persisted }),
    capture: resolveProxyToggle("capture", { ...opts, persisted }),
  };
}

/**
 * Persist one toggle, preserving everything else in the file.
 *
 * The file holds the API KEY. Two consequences drive this
 * implementation:
 *
 *   * It is read-modify-written, never overwritten, so turning capture
 *     off cannot cost the user their credentials.
 *   * If the existing file cannot be parsed, this THROWS rather than
 *     starting from `{}`. Clobbering bytes that may still contain a
 *     recoverable key, in the name of recording a preference, is a
 *     trade nobody would agree to if asked.
 *
 * Perms are re-asserted at 0600 on every write (writeFileSync's `mode`
 * applies only on create), matching `writeCloudConfig`.
 */
export function setPersistedToggle(
  name: ProxyToggleName,
  enabled: boolean,
  path: string = cloudConfigPath(),
): void {
  const existing = readConfigObjectStrict(path);
  const proxyBlock = existing["proxy"];
  const proxy =
    proxyBlock !== null && typeof proxyBlock === "object" && !Array.isArray(proxyBlock)
      ? (proxyBlock as Record<string, unknown>)
      : {};

  writeConfigObject({ ...existing, proxy: { ...proxy, [name]: enabled } }, path);
}

// ---- internals --------------------------------------------------------

/**
 * Same, but for the WRITE path, where "I could not read it" and "there
 * is nothing there" must not be conflated. A MISSING file is an empty
 * object (first-run, nothing to lose); a PRESENT-but-unparseable file
 * throws — and a zero-byte file counts as present-but-unparseable, not
 * missing. Reading `raw.trim() === ""` as first-run was itself the bug:
 * a zero-byte file is exactly what a non-atomic write leaves behind
 * when it is interrupted between truncating the file and finishing the
 * new content, so treating it as "nothing to preserve" turned the next
 * toggle write into a config with the API key silently gone. It gets
 * the same refuse-and-preserve handling as any other unparseable
 * content: `JSON.parse("")` throws on its own, so there is nothing
 * special to do here beyond NOT short-circuiting past it.
 */
function readConfigObjectStrict(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {}; // no file yet — nothing to preserve
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${path} could not be parsed as JSON, so it was left untouched. ` +
        `It may still hold your API key — fix or remove the file, then retry.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `${path} could not be parsed as a JSON object, so it was left untouched. ` +
        `Fix or remove the file, then retry.`,
    );
  }
  return parsed as Record<string, unknown>;
}
