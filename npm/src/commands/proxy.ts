// `klio proxy <ensure|status|serve>` — the command the supervisor runs.
//
// Kept separate from `klio doctor` because the two have different
// audiences and different failure behaviour. `doctor` talks to a human
// and fixes everything it can. `ensure` is called every 60 seconds by
// launchd/systemd, prints almost nothing, and only ever does one thing:
// if the proxy is not answering, bring it back — via `docker compose up`
// in local mode, or by spawning our own detached `proxy serve` in cloud
// mode (see ../proxy/processSupervisor.ts). `serve` is the foreground
// command that revival execs.
//
// Exit codes matter here — they are the supervisor's only signal:
//   0  proxy is answering (either it already was, or we revived it)
//   1  proxy is not answering and we could not fix it

import { resolve } from "node:path";

import { readCloudConfig } from "../cloudConfig.js";
import { runtimeDir } from "../compose.js";
import { composeUpService, resolveComposeBin } from "../docker.js";
import { PROXY_PORT, PROXY_SERVICE } from "../proxy/constants.js";
import { isProxyRunning, readPid, spawnProxy } from "../proxy/processSupervisor.js";
import { startProxy } from "../proxy/server.js";
import { probeProxy } from "../proxy/supervisor.js";

export type ProxyCommandOptions = {
  args: string[];
  log?: (line: string) => void;
  /**
   * Injection seams for tests. Production leaves all of these
   * undefined and gets the real implementations; the unit suite
   * substitutes recording stubs so it never spawns a process, hits
   * Docker, or touches the real filesystem.
   */
  probeProxyImpl?: typeof probeProxy;
  resolveComposeBinImpl?: typeof resolveComposeBin;
  composeUpServiceImpl?: typeof composeUpService;
  readCloudConfigImpl?: typeof readCloudConfig;
  spawnProxyImpl?: typeof spawnProxy;
  isProxyRunningImpl?: typeof isProxyRunning;
  readPidImpl?: typeof readPid;
  startProxyImpl?: typeof startProxy;
  /** Absolute path to the CLI entrypoint, used when spawning `proxy serve`. */
  cliPath?: string;
};

export async function runProxyCommand(opts: ProxyCommandOptions): Promise<number> {
  const log = opts.log ?? ((line: string) => process.stdout.write(line + "\n"));
  const sub = opts.args[0] ?? "status";

  switch (sub) {
    case "ensure":
      return ensure(log, opts);
    case "status":
      return status(log, opts);
    case "serve":
      return serve(log, opts);
    default:
      process.stderr.write(
        `klio proxy: unknown subcommand: ${sub}\nusage: klio proxy <ensure|status|serve>\n`,
      );
      return 2;
  }
}

/**
 * Bring the proxy back if it is not answering.
 *
 * Idempotent and cheap in the common case: one HTTP GET against
 * loopback, then nothing. The expensive path — resolving docker compose
 * and starting a service in local mode, or spawning our own detached
 * `proxy serve` in cloud mode — only runs when the probe fails, which
 * is what makes it safe to schedule every minute.
 *
 * The probe is the ONLY authority on "is it up". The pid file consulted
 * on the cloud path is best-effort bookkeeping to avoid spawning a
 * second proxy on top of one already coming up; it never substitutes
 * for the probe result.
 */
async function ensure(log: (line: string) => void, opts: ProxyCommandOptions): Promise<number> {
  const probe = opts.probeProxyImpl ?? probeProxy;
  const readConfig = opts.readCloudConfigImpl ?? readCloudConfig;

  const first = await probe();
  if (first.alive) return 0;

  log(`klio proxy: not answering (${first.detail}) — restarting`);

  // Mode detection reuses the signal `klio init` already writes: cloud
  // init (src/commands/initCloud.ts) persists ~/.klio/config.json via
  // writeCloudConfig; local init never does. No new config file needed.
  const cloudMode = readConfig() !== null;

  try {
    if (cloudMode) {
      await reviveCloud(opts);
    } else {
      const resolveBin = opts.resolveComposeBinImpl ?? resolveComposeBin;
      const composeUp = opts.composeUpServiceImpl ?? composeUpService;
      // `up -d --no-deps <service>` rather than `restart`: restart is a
      // no-op when the container does not exist at all, which is exactly
      // the state after a reboot where Docker started fresh.
      const bin = await resolveBin();
      await composeUp(bin, runtimeDir(), PROXY_SERVICE);
    }
  } catch (err) {
    log(`klio proxy: restart failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // Give the proxy a moment to bind. It has no dependencies to wait on,
  // so this is short — but not zero, because reporting failure
  // immediately after a successful revive would make the supervisor
  // thrash.
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(500);
    const again = await probe();
    if (again.alive) {
      log("klio proxy: back up");
      return 0;
    }
  }

  log("klio proxy: restarted but still not answering — run `klio doctor`");
  return 1;
}

/**
 * Cloud-mode revive: no compose file, no daemon — spawn the CLI's own
 * `proxy serve` detached. Skips spawning when the last recorded pid is
 * still alive (best-effort — see the module-level note on `ensure`).
 */
async function reviveCloud(opts: ProxyCommandOptions): Promise<void> {
  const readPidImpl = opts.readPidImpl ?? readPid;
  const isRunning = opts.isProxyRunningImpl ?? isProxyRunning;

  const existingPid = readPidImpl();
  if (existingPid !== null && isRunning(existingPid)) {
    // Already coming up (or hung) under a pid we recorded — avoid
    // spawning a duplicate. The retry loop in `ensure` decides whether
    // this counts as success; the pid alone never does.
    return;
  }

  const spawn = opts.spawnProxyImpl ?? spawnProxy;
  const cliPath = opts.cliPath ?? resolve(process.argv[1] ?? "");
  spawn({ cliPath });
}

/** One-line liveness report for humans and scripts. */
async function status(log: (line: string) => void, opts: ProxyCommandOptions): Promise<number> {
  const probe = opts.probeProxyImpl ?? probeProxy;
  const result = await probe();
  log(result.alive ? `klio proxy: ${result.detail}` : `klio proxy: down (${result.detail})`);
  return result.alive ? 0 : 1;
}

/**
 * Run the proxy in the foreground. This is what `spawnProxy` execs
 * detached in cloud mode, and what a user can run directly to watch
 * logs live. Refuses to start a second listener on top of one already
 * bound to the port — `startProxy` itself rejects cleanly on
 * EADDRINUSE rather than throwing an uncaught exception, so this just
 * has to translate that rejection into a clear exit.
 */
async function serve(log: (line: string) => void, opts: ProxyCommandOptions): Promise<number> {
  const start = opts.startProxyImpl ?? startProxy;
  try {
    await start({});
    // Deliberately never returns to the shell in production: the
    // listening server holds an open handle, which keeps the process
    // (and the event loop `process.exitCode` would otherwise let drain)
    // alive until something kills it.
    return 0;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EADDRINUSE") {
      log(`klio proxy: already listening on port ${PROXY_PORT}`);
      return 1;
    }
    log(`klio proxy: failed to start: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
