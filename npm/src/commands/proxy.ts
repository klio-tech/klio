// `klio proxy <ensure|status|serve|stop>` — the command the supervisor runs.
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
import { spawnProxy } from "../proxy/processSupervisor.js";
import { startProxy } from "../proxy/server.js";
import { stopProxy } from "../proxy/stop.js";
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
  startProxyImpl?: typeof startProxy;
  stopProxyImpl?: typeof stopProxy;
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
    case "stop":
      return stop(log, opts);
    default:
      process.stderr.write(
        `klio proxy: unknown subcommand: ${sub}\nusage: klio proxy <ensure|status|serve|stop>\n`,
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
 * The probe is the ONLY authority on "is it up" — including on the
 * cloud path. `spawnProxy` always runs when the probe has failed; it
 * is NOT gated behind a `kill(pid, 0)` check on the last recorded pid.
 * A pid can be recycled by an unrelated process (a coincidental
 * `sleep 300 &` reusing the number is enough), so "does a process with
 * this pid exist" can never stand in for "is our proxy listening" —
 * gating on it would make revival silently stop working for as long as
 * the coincidental holder lives, with the supervisor reporting failure
 * forever and never trying again. Deduplication instead falls out of
 * `startProxy`'s own EADDRINUSE rejection: if a proxy is already up,
 * the spawned `proxy serve` exits 1 within about a second and the
 * still-running original keeps answering the next probe. The pid file
 * is written purely for bookkeeping (see processSupervisor.ts).
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
 * `proxy serve` detached. Always runs when called (the probe having
 * already failed is what gated the call); see the note on `ensure`
 * for why a pid-liveness pre-check would be unsound here.
 */
async function reviveCloud(opts: ProxyCommandOptions): Promise<void> {
  const spawn = opts.spawnProxyImpl ?? spawnProxy;
  const cliPath = opts.cliPath ?? resolve(process.argv[1] ?? "");
  spawn({ cliPath });
}

/**
 * Stop the running proxy.
 *
 * Exit codes follow the same rule as the rest of this command: 0 when
 * the proxy is not running (whether it already wasn't, or because we
 * just stopped it — both leave the user where they asked to be), 1 when
 * something is still listening that we could not or would not stop.
 */
async function stop(log: (line: string) => void, opts: ProxyCommandOptions): Promise<number> {
  const stopImpl = opts.stopProxyImpl ?? stopProxy;
  const result = await stopImpl({ probeImpl: opts.probeProxyImpl ? () => opts.probeProxyImpl!() : undefined });
  log(`klio proxy: ${result.detail}`);
  return !result.wasRunning || result.stopped ? 0 : 1;
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
