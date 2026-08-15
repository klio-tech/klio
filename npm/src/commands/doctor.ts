// `klio doctor` — verify the proxy wiring, and heal what it can.
//
// Four checks, in dependency order, because a later check failing is
// only meaningful once the earlier ones pass:
//
//   1. Settings entry present in ~/.claude/settings.json (and Codex's
//      config, when Codex is installed). Re-applied if another writer
//      removed it — the design anticipates exactly this, since the file
//      has several writers and none of them coordinate.
//   2. Supervisor installed, so the proxy survives a reboot.
//   3. Proxy alive — and restarted if not.
//   4. An END-TO-END request actually succeeds through the proxy.
//
// Check 4 is the one that matters, and the reason the other three are
// not enough. A proxy can pass a health check while being unable to
// reach Anthropic (DNS, a corporate TLS-inspecting middlebox, an
// expired system trust store) — and from the agent's point of view
// that is indistinguishable from Klio being broken. So doctor makes a
// real request and reports what came back.
//
// Deliberately NOT a check: whether compression is saving tokens. This
// release is pass-through only, and doctor should not imply otherwise.

import { resolve } from "node:path";

import { readCloudConfig } from "../cloudConfig.js";
import { runtimeDir } from "../compose.js";
import { composeUpService, resolveComposeBin } from "../docker.js";
import { readProxyEnv, applyProxyEnv } from "../proxy/claudeCodeProxy.js";
import { CODEX_BASE_URL, codexInstalled, readCodexProxy } from "../proxy/codexProxy.js";
import {
  CLAUDE_ENV_KEYS,
  PROXY_BASE_URL,
  PROXY_PROBE_URL,
  PROXY_SERVICE,
  claudeProxyEnv,
} from "../proxy/constants.js";
import { spawnProxy } from "../proxy/processSupervisor.js";
import { detectSupervisor, probeProxy, supervisorPaths } from "../proxy/supervisor.js";
import { existsSync } from "node:fs";

export type CheckStatus = "ok" | "healed" | "warn" | "fail";

export type Check = {
  name: string;
  status: CheckStatus;
  detail: string;
};

export type DoctorOptions = {
  log?: (line: string) => void;
  /** Skip the network round trip. For CI, and for offline debugging. */
  skipEndToEnd?: boolean;
  /** Do not modify anything — report only. */
  dryRun?: boolean;
  /**
   * Injection seams. Production leaves every one undefined and gets the
   * real implementation; the unit suite substitutes recorders so it
   * never probes the real port, spawns a process, or shells out to
   * Docker.
   */
  readCloudConfigFn?: typeof readCloudConfig;
  probeProxyFn?: typeof probeProxy;
  spawnProxyFn?: typeof spawnProxy;
  resolveComposeBinFn?: typeof resolveComposeBin;
  composeUpServiceFn?: typeof composeUpService;
  sleepFn?: (ms: number) => Promise<void>;
  /** Absolute path to the CLI entrypoint, used when spawning `proxy serve`. */
  cliPath?: string;
};

export async function doctor(opts: DoctorOptions = {}): Promise<number> {
  const log = opts.log ?? ((line: string) => process.stdout.write(line + "\n"));
  const checks: Check[] = [];

  log("");
  log("klio doctor — checking the compression proxy");
  log("");

  checks.push(checkClaudeSettings(opts.dryRun ?? false));
  const codexCheck = checkCodex();
  if (codexCheck) checks.push(codexCheck);
  checks.push(checkSupervisor());
  checks.push(await checkProxyAlive(opts, log));

  if (!opts.skipEndToEnd) {
    checks.push(await checkEndToEnd(checks));
  }

  for (const check of checks) {
    log(`  ${marker(check.status)} ${check.name}`);
    log(`      ${check.detail}`);
  }
  log("");

  const failed = checks.filter((c) => c.status === "fail");
  const healed = checks.filter((c) => c.status === "healed");

  if (healed.length > 0) {
    log(`  Repaired ${healed.length} problem(s).`);
  }
  if (failed.length === 0) {
    log("  Everything checks out. (Pass-through only — no compression yet.)");
    log("");
    return 0;
  }

  log(`  ${failed.length} problem(s) need attention:`);
  for (const check of failed) log(`    - ${check.name}: ${check.detail}`);
  log("");
  log("  If your agent cannot reach a model right now, `klio uninit` removes");
  log("  the proxy wiring and puts you straight back on api.anthropic.com.");
  log("");
  return 1;
}

/**
 * Check 1 — the settings entry, re-applied if missing.
 *
 * The design calls this out explicitly: settings.json has more than one
 * writer, and any of them can drop our keys. Re-applying is not
 * optional, because the failure mode of a missing ANTHROPIC_BASE_URL is
 * benign (traffic goes straight to Anthropic) while the failure mode of
 * a missing ENABLE_TOOL_SEARCH is not — it is a silent ~85% regression
 * on tool schemas that nobody notices.
 */
function checkClaudeSettings(dryRun: boolean): Check {
  const current = readProxyEnv();
  const desired = claudeProxyEnv();
  const wrong = CLAUDE_ENV_KEYS.filter((k) => current[k] !== desired[k]);

  if (wrong.length === 0) {
    return {
      name: "Claude Code settings",
      status: "ok",
      detail: `ANTHROPIC_BASE_URL=${PROXY_BASE_URL}, ENABLE_TOOL_SEARCH=true`,
    };
  }

  if (dryRun) {
    return {
      name: "Claude Code settings",
      status: "warn",
      detail: `${wrong.join(", ")} missing or wrong (not fixed: --dry-run)`,
    };
  }

  try {
    const result = applyProxyEnv();
    return {
      name: "Claude Code settings",
      status: "healed",
      detail: `re-applied ${result.changes.map((c) => c.key).join(", ")} in ${result.settingsPath}`,
    };
  } catch (err) {
    return {
      name: "Claude Code settings",
      status: "fail",
      detail: `could not write settings: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Check 1b — Codex, only when Codex is actually installed. */
function checkCodex(): Check | null {
  if (!codexInstalled()) return null;
  const { selected, baseUrl } = readCodexProxy();

  if (selected === "klio-proxy" && baseUrl === CODEX_BASE_URL) {
    return { name: "Codex settings", status: "ok", detail: `model_provider → ${baseUrl}` };
  }
  if (baseUrl === CODEX_BASE_URL) {
    return {
      name: "Codex settings",
      status: "warn",
      detail:
        `Klio's provider block is present but model_provider = ` +
        `${selected === null ? "(unset)" : `"${selected}"`}. Codex is not using the proxy.`,
    };
  }
  return {
    name: "Codex settings",
    status: "warn",
    detail: "Codex is installed but not wired to the proxy — run `klio init` to wire it",
  };
}

/**
 * Check 2 — the supervisor.
 *
 * A warning rather than a failure: without it the proxy still works
 * right now, it just will not come back after a reboot. Reporting that
 * as a hard failure would train people to ignore doctor's output.
 */
function checkSupervisor(): Check {
  const kind = detectSupervisor();
  const paths = supervisorPaths();

  if (kind === "launchd" && existsSync(paths.launchAgent)) {
    return { name: "Supervisor", status: "ok", detail: `launchd agent at ${paths.launchAgent}` };
  }
  if (kind === "systemd" && existsSync(paths.systemdTimer)) {
    return { name: "Supervisor", status: "ok", detail: `systemd timer at ${paths.systemdTimer}` };
  }
  if (kind === "windows") {
    return {
      name: "Supervisor",
      status: "warn",
      detail:
        "Windows: Docker's restart policy covers crashes. For reboots, enable " +
        '"Start Docker Desktop when you sign in".',
    };
  }
  return {
    name: "Supervisor",
    status: "warn",
    detail: "not installed — the proxy will not restart after a reboot. Re-run `klio init`.",
  };
}

/**
 * Check 3 — is the proxy answering, and can we bring it back if not.
 *
 * How it is brought back depends on how it RUNS, and the two ways have
 * nothing in common. `ensure()` (commands/proxy.ts) already branches on
 * exactly this signal — cloud init writes ~/.klio/config.json, local
 * init never does — and doctor has to branch the same way. It did not:
 * it went straight to `resolveComposeBin()`, so on a Docker-free cloud
 * machine the documented recovery ("`klio doctor` checks and heals", in
 * the consent text at wiring.ts) was impossible, and the user was told
 * their problem was Docker while ANTHROPIC_BASE_URL pointed at a dead
 * port and their agent could not reach a model at all.
 */
async function checkProxyAlive(opts: DoctorOptions, log: (line: string) => void): Promise<Check> {
  const probe = opts.probeProxyFn ?? probeProxy;
  const sleepFn = opts.sleepFn ?? sleep;
  const cloudMode = (opts.readCloudConfigFn ?? readCloudConfig)() !== null;

  const first = await probe();
  if (first.alive) {
    return { name: "Proxy process", status: "ok", detail: `${PROXY_PROBE_URL} — ${first.detail}` };
  }

  if (opts.dryRun) {
    return { name: "Proxy process", status: "fail", detail: `down (${first.detail})` };
  }

  log(`  … proxy not answering (${first.detail}), restarting`);
  try {
    if (cloudMode) {
      // Same revival as `ensure`'s cloud path: spawn our own detached
      // `proxy serve`. No daemon, no compose file, nothing to install.
      const spawn = opts.spawnProxyFn ?? spawnProxy;
      spawn({ cliPath: opts.cliPath ?? resolve(process.argv[1] ?? "") });
    } else {
      const bin = await (opts.resolveComposeBinFn ?? resolveComposeBin)();
      await (opts.composeUpServiceFn ?? composeUpService)(bin, runtimeDir(), PROXY_SERVICE);
    }
  } catch (err) {
    return {
      name: "Proxy process",
      status: "fail",
      detail:
        `down and could not be restarted: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        (cloudMode
          ? `Run \`klio proxy serve\` in a terminal to see why it will not start. `
          : `Is Docker running? `) +
        `Your agent cannot reach a model until this is fixed — ` +
        `\`klio uninit\` is the escape hatch.`,
    };
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    await sleepFn(500);
    const again = await probe();
    if (again.alive) {
      return { name: "Proxy process", status: "healed", detail: `restarted — ${again.detail}` };
    }
  }
  return {
    name: "Proxy process",
    status: "fail",
    detail: cloudMode
      ? "restarted but still not answering — run `klio proxy serve` to see the error, " +
        "or `klio uninit` to remove the wiring"
      : "restarted but still not answering — check `docker logs klio-proxy`",
  };
}

/**
 * Check 4 — a real request, all the way through.
 *
 * Uses `POST /v1/messages` with no credentials. A 401 from Anthropic is
 * a PASS: it proves the request crossed the proxy, resolved DNS,
 * completed TLS, reached Anthropic's servers, and got a real answer
 * back. The only thing missing is a key, which doctor deliberately does
 * not have — reading the user's credentials to run a health check would
 * be a worse trade than the extra certainty is worth.
 *
 * What distinguishes pass from fail is the SHAPE of the response, not
 * its status: an `x-klio-proxy-error` header means the proxy could not
 * reach Anthropic and said so.
 */
async function checkEndToEnd(previous: Check[]): Promise<Check> {
  if (previous.some((c) => c.name === "Proxy process" && c.status === "fail")) {
    return {
      name: "End-to-end request",
      status: "fail",
      detail: "skipped — the proxy is not running",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${PROXY_PROBE_URL}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-3-5-haiku-latest", max_tokens: 1, messages: [] }),
      signal: controller.signal,
    });

    const proxyError = response.headers.get("x-klio-proxy-error");
    if (proxyError) {
      const body = await response.text();
      return {
        name: "End-to-end request",
        status: "fail",
        detail: `the proxy could not reach Anthropic (${proxyError}): ${body.slice(0, 300)}`,
      };
    }

    // Any real Anthropic status is a pass — the round trip happened.
    // 401 (no key) and 400 (empty messages) are both expected here.
    return {
      name: "End-to-end request",
      status: "ok",
      detail:
        `POST /v1/messages returned ${response.status} from Anthropic through the proxy ` +
        `(${response.status === 401 ? "no API key sent, as expected" : "round trip confirmed"})`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: "End-to-end request",
      status: "fail",
      detail: message.includes("abort")
        ? "no response within 15s — the proxy accepted the request but never answered"
        : `request failed: ${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function marker(status: CheckStatus): string {
  switch (status) {
    case "ok":
      return "✓";
    case "healed":
      return "✓";
    case "warn":
      return "!";
    case "fail":
      return "✗";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
