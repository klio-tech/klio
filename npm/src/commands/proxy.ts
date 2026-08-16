// `klio proxy <ensure|status|serve|stop|inject|capture>` — the command
// the supervisor runs, plus the two kill switches.
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

import { cloudConfigPath, readCloudConfig } from "../cloudConfig.js";
import { runtimeDir } from "../compose.js";
import { composeUpService, resolveComposeBin } from "../docker.js";
import { PROXY_SERVICE } from "../proxy/constants.js";
import { spawnProxy } from "../proxy/processSupervisor.js";
import { startProxy } from "../proxy/server.js";
import { resolveServeOptions } from "../proxy/serveOptions.js";
import { stopProxy } from "../proxy/stop.js";
import { probeProxy } from "../proxy/supervisor.js";
import {
  PROXY_TOGGLE_DESCRIPTION,
  PROXY_TOGGLE_ENV,
  PROXY_TOGGLE_NAMES,
  resolveProxyToggles,
  setPersistedToggle,
  type ProxyToggleName,
  type ResolvedToggle,
} from "../proxy/toggles.js";

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
  /** Environment the toggle subcommands read. Defaults to this process's. */
  env?: NodeJS.ProcessEnv;
  /** Config file the toggle subcommands read and write. Defaults to ~/.klio/config.json. */
  configPathImpl?: () => string;
  /** Injectable delay, so the restart loop costs tests nothing. */
  sleepImpl?: (ms: number) => Promise<void>;
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
    case "inject":
    case "capture":
      return toggle(sub, log, opts);
    default:
      process.stderr.write(
        `klio proxy: unknown subcommand: ${sub}\n` +
          `usage: klio proxy <ensure|status|serve|stop>\n` +
          `       klio proxy <inject|capture> [on|off]\n`,
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
 * still-running original keeps answering the next probe. NOTHING
 * RECORDS A PID at all — `processSupervisor.ts` explains why the pid
 * file was removed rather than kept "for bookkeeping": every reader of
 * it was unsound, and the one attempt to use it broke revival on a live
 * machine. `pidFilePath` survives only so `klio uninit` can delete what
 * an older install left behind.
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

/**
 * One-line liveness report for humans and scripts, plus the SETTINGS.
 *
 * The two are different questions and the second one is the one nobody
 * could answer before: `mode` in the health body describes the process
 * that happens to be running now, which after a supervisor restart is
 * not necessarily what the user asked for. Printing the resolved
 * settings — and where each came from — is what makes "did my opt-out
 * stick?" answerable without reading a JSON file.
 */
async function status(log: (line: string) => void, opts: ProxyCommandOptions): Promise<number> {
  const probe = opts.probeProxyImpl ?? probeProxy;
  const result = await probe();
  log(result.alive ? `klio proxy: ${result.detail}` : `klio proxy: down (${result.detail})`);
  for (const line of describeToggles(opts)) log(`  ${line}`);
  return result.alive ? 0 : 1;
}

/** `  inject: on (default)` / `  capture: off (saved setting …)`, one per half. */
function describeToggles(opts: ProxyCommandOptions): string[] {
  const toggles = resolveProxyToggles({
    env: opts.env ?? process.env,
    configPath: (opts.configPathImpl ?? cloudConfigPath)(),
  });
  return PROXY_TOGGLE_NAMES.map(
    (name) => `${name}: ${describeToggle(name, toggles[name], opts)}`,
  );
}

function describeToggle(
  name: ProxyToggleName,
  toggle: ResolvedToggle,
  opts: ProxyCommandOptions,
): string {
  const state = toggle.enabled ? "on" : "off";
  switch (toggle.source) {
    case "env":
      return `${state} (${PROXY_TOGGLE_ENV[name]} in this shell)`;
    case "config":
      return `${state} (saved setting in ${(opts.configPathImpl ?? cloudConfigPath)()})`;
    default:
      return `${state} (default)`;
  }
}

/**
 * `klio proxy <inject|capture> [on|off]` — the durable kill switch.
 *
 * With no value it reports; with one it records the choice in
 * ~/.klio/config.json, which is what the proxy reads at boot however it
 * was started. The env var remains a per-process override and is
 * deliberately NOT written anywhere: a supervisor-spawned proxy never
 * sees the user's shell, which is the whole reason this command exists.
 *
 * Recording the choice is not the same as APPLYING it: `startProxy`
 * reads the setting once at boot, so a proxy that is already running
 * keeps doing what it was doing. This command therefore restarts a
 * running Klio proxy in place — and when it cannot (a container, an
 * older proxy, a process it may not signal), it says so and exits
 * nonzero rather than let "capture is now off" stand while the running
 * proxy keeps sending conversations.
 */
async function toggle(
  name: ProxyToggleName,
  log: (line: string) => void,
  opts: ProxyCommandOptions,
): Promise<number> {
  const configPath = (opts.configPathImpl ?? cloudConfigPath)();
  const env = opts.env ?? process.env;
  const raw = opts.args[1];

  if (raw === undefined) {
    const toggles = resolveProxyToggles({ env, configPath });
    log(`klio proxy ${name}: ${describeToggle(name, toggles[name], opts)}`);
    log(`  ${name} = ${PROXY_TOGGLE_DESCRIPTION[name]}`);
    log(`  change it with: klio proxy ${name} <on|off>`);
    return 0;
  }

  const desired = parseOnOff(raw);
  if (desired === null) {
    log(`klio proxy ${name}: "${raw}" is not on|off`);
    log(`  usage: klio proxy ${name} <on|off>`);
    return 2;
  }

  try {
    setPersistedToggle(name, desired, configPath);
  } catch (err) {
    log(`klio proxy ${name}: could not save the setting: ${messageOf(err)}`);
    return 1;
  }
  log(`klio proxy: ${name} is now ${desired ? "on" : "off"} (saved in ${configPath})`);
  log(`  ${name} = ${PROXY_TOGGLE_DESCRIPTION[name]}`);

  // A shell export beats the file for every process started from that
  // shell — including the proxy this command is about to restart, which
  // inherits this process's environment. Saying nothing here would let
  // the user believe a setting that their own shell is overriding.
  const override = env[PROXY_TOGGLE_ENV[name]];
  if (override !== undefined && override.trim() !== "") {
    log(
      `  ! ${PROXY_TOGGLE_ENV[name]}=${override} is set in this shell and overrides the saved ` +
        `setting for anything started from it. Unset it to let the saved setting apply.`,
    );
  }

  return applyToRunningProxy(log, opts);
}

/**
 * Make a change take effect on the proxy that is already listening.
 *
 * Restarting is stop-then-spawn, the same two steps `klio init` uses,
 * and it inherits `stopProxy`'s refusal to signal anything that has not
 * proven it is ours (proxy/stop.ts). The failure modes are reported
 * distinctly because they mean different things to the user:
 *
 *   * nothing on the port at all → the setting simply applies at the
 *     next start;
 *   * something on the port that is not ours (a foreign listener, or
 *     ours but a different runtime) → we will not touch it, and the
 *     user has to restart it the way it was started;
 *   * ours, but it would not stop → the OLD behaviour is still live.
 *
 * Only the last is an error exit: it is the one where the user asked
 * for their conversations to stop leaving the machine and they have
 * not.
 *
 * The first two are told apart with `responded`, not `alive` — the
 * same distinction `probeProxy` documents and `stopProxy` already
 * relies on. `alive` is false in BOTH cases (a foreign responder is
 * never "alive" as a Klio proxy), so branching on it alone made a
 * stranger squatting on the port look identical to an empty port: the
 * "not running; applies next start" message is wrong when something
 * IS there, and it is the exact phrasing that was removed from
 * `stopProxy` for the same reason.
 */
async function applyToRunningProxy(
  log: (line: string) => void,
  opts: ProxyCommandOptions,
): Promise<number> {
  const probe = opts.probeProxyImpl ?? probeProxy;
  const stopImpl = opts.stopProxyImpl ?? stopProxy;
  const spawn = opts.spawnProxyImpl ?? spawnProxy;
  const nap = opts.sleepImpl ?? sleep;

  const before = await probe();
  if (!before.responded) {
    log("  The proxy is not running; the setting applies the next time it starts.");
    return 0;
  }
  if (!before.alive || before.health?.runtime !== "node") {
    log(
      "  Something other than this CLI's proxy is on the port, so it was left alone. " +
        "Restart it for the change to take effect.",
    );
    return 0;
  }

  const stopped = await stopImpl();
  if (!stopped.stopped) {
    log(`  ! Could not restart the running proxy: ${stopped.detail}`);
    log("    It is still running with the OLD setting. The saved setting applies");
    log("    at its next start; `klio uninit` stops the proxy outright.");
    return 1;
  }

  try {
    spawn({ cliPath: opts.cliPath ?? resolve(process.argv[1] ?? "") });
  } catch (err) {
    log(`  ! The proxy was stopped but could not be restarted: ${messageOf(err)}`);
    log("    The supervisor brings it back within a minute; `klio proxy ensure` is faster.");
    return 1;
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    await nap(500);
    const again = await probe();
    if (again.alive) {
      log(`  Restarted — ${again.detail}`);
      return 0;
    }
  }

  log("  ! The proxy was restarted but is not answering yet — run `klio proxy ensure`.");
  return 1;
}

/** Strict on/off parsing. An unrecognised word is refused, never guessed at. */
function parseOnOff(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (["on", "true", "1", "yes", "enable", "enabled"].includes(v)) return true;
  if (["off", "false", "0", "no", "disable", "disabled"].includes(v)) return false;
  return null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

  // `--port`/`--host`/`--upstream`, or KLIO_PROXY_PORT/_HOST/_UPSTREAM.
  // See serveOptions.ts for why these exist at all.
  const resolved = resolveServeOptions(opts.args.slice(1), opts.env ?? process.env);
  if (!resolved.ok) {
    log(`klio proxy: ${resolved.error}`);
    return 1;
  }

  try {
    await start(resolved.options);
    // Deliberately never returns to the shell in production: the
    // listening server holds an open handle, which keeps the process
    // (and the event loop `process.exitCode` would otherwise let drain)
    // alive until something kills it.
    return 0;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EADDRINUSE") {
      log(`klio proxy: already listening on port ${resolved.options.port}`);
      return 1;
    }
    log(`klio proxy: failed to start: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
