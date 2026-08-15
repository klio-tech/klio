// `klio down` — stop the stack without deleting any data.
//
// `klio uninstall` — stop + delete volumes (postgres, engine KMS,
// bridge keychain, redis AOF). Irreversible. Also restores Claude
// Code/Cursor configs from their backups.
//
// Why two separate commands: `down` is the everyday "I'm rebooting,
// give me my CPU back" action; `uninstall` is the rare "purge
// everything" action. Conflating them risks accidental data loss.

import { banner, ok, runSteps, type StepResult } from "../ui.js";
import { composeDown, resolveComposeBin } from "../docker.js";
import { runtimeDir } from "../compose.js";
import { allAdapters, type Adapter } from "../adapters/types.js";
import { readCloudConfig } from "../cloudConfig.js";
import { stopProxy } from "../proxy/stop.js";
import { uninstallSupervisor } from "../proxy/supervisor.js";
import { unwireProxy } from "../proxy/wiring.js";

export type DownOptions = {
  /** Single-line writer for the cloud path. Defaults to stdout. */
  log?: (line: string) => void;
  /** Injection seams; production leaves them undefined. */
  readCloudConfigFn?: typeof readCloudConfig;
  stopProxyFn?: typeof stopProxy;
  resolveComposeBinFn?: typeof resolveComposeBin;
  composeDownFn?: typeof composeDown;
};

/**
 * Stop whatever Klio is running.
 *
 * "Whatever Klio is running" is not the same thing in the two modes, and
 * reaching for compose unconditionally is wrong in exactly the way it
 * was wrong in `ensure`, `doctor` and `uninit`: cloud has no stack at
 * all — one detached `proxy serve` process — so a Docker-free machine
 * got a Docker error while the proxy kept listening. The mode signal is
 * the same one every other command uses: cloud init writes
 * ~/.klio/config.json, local init never does.
 */
export async function down(opts: DownOptions = {}): Promise<void> {
  const log = opts.log ?? ((line: string) => process.stdout.write(line + "\n"));
  banner("Stopping Klio");

  if ((opts.readCloudConfigFn ?? readCloudConfig)() !== null) {
    const result = await (opts.stopProxyFn ?? stopProxy)();
    log(`  ${result.stopped ? "✓" : result.wasRunning ? "!" : "—"} ${result.detail}`);
    log("  Cloud mode keeps no local stack — your memory lives on the hosted brain.");
    return;
  }

  const bin = await (opts.resolveComposeBinFn ?? resolveComposeBin)();
  const start = Date.now();
  await (opts.composeDownFn ?? composeDown)(bin, runtimeDir(), false);
  ok("stack stopped (data preserved)", Date.now() - start);
}

export type UninstallOptions = {
  /** Single-line writer for the proxy/supervisor lines. Defaults to stdout. */
  log?: (line: string) => void;
  /**
   * Injection seams; production leaves every one undefined. The unit
   * suite MUST substitute all of them: the real adapters restore the
   * developer's own ~/.claude and ~/.codex from Klio backups, and the
   * real supervisor removal unloads their launchd agent.
   */
  readCloudConfigFn?: typeof readCloudConfig;
  unwireProxyFn?: typeof unwireProxy;
  uninstallSupervisorFn?: typeof uninstallSupervisor;
  stopProxyFn?: typeof stopProxy;
  resolveComposeBinFn?: typeof resolveComposeBin;
  composeDownFn?: typeof composeDown;
  adaptersFn?: () => Adapter[];
};

/**
 * Take Klio off this machine.
 *
 * ORDER IS THE WHOLE DESIGN HERE, and it is the thing that was wrong.
 * "Stop containers and remove volumes" ran first and is non-optional,
 * and `runSteps` rethrows on a non-optional failure — so on a cloud
 * machine (no Docker by definition) uninstall died on step one with
 * `docker compose not found`, and every step that would have made the
 * machine usable again never ran. The user was left with agents still
 * pointed at 127.0.0.1:8787, a proxy still holding their API key, and a
 * supervisor that would revive it a minute after they killed it.
 *
 * So the steps are ordered by "what does the user lose if this is where
 * we stop", strictest first:
 *
 *   1. Un-wire the agents. After this, an agent talks to
 *      api.anthropic.com again no matter what else fails.
 *   2. Remove the supervisor. Before stopping the proxy, not after —
 *      otherwise `proxy ensure` brings it straight back.
 *   3. Stop the proxy (cloud mode only; in local mode it is a container
 *      and step 5 takes it down with the rest of the stack).
 *   4. Restore each agent's config from its backup.
 *   5. Stop the containers and remove the volumes — the only step that
 *      needs Docker, so it is last, and the only one still allowed to
 *      fail the command, because "your data was not deleted" is
 *      something the user has to be told.
 *
 * Steps 1–4 are `optional`, which in this UI means a failure degrades
 * to a warning and the run continues. That is right for an escape
 * hatch: one broken config file must not strand everything after it.
 */
export async function uninstall(opts: UninstallOptions = {}): Promise<void> {
  const log = opts.log ?? ((line: string) => process.stdout.write(line + "\n"));
  banner("Uninstalling Klio");

  const cloudMode = (opts.readCloudConfigFn ?? readCloudConfig)() !== null;

  // One step per adapter, generated from the canonical registry.
  // Adding a new agent in `allAdapters()` extends uninstall coverage
  // automatically — no edit here required.
  const adapterSteps = (opts.adaptersFn ?? allAdapters)().map((adapter) => ({
    title: `Restore ${adapter.name()} config from backup`,
    optional: true,
    run: async (): Promise<StepResult> => {
      if (!adapter.installed()) {
        return { kind: "skip" as const, reason: "not installed" };
      }
      await adapter.uninstall();
      return { kind: "ok" as const, status: "restored" };
    },
  }));

  await runSteps([
    {
      title: "Un-wire agents from the local proxy",
      optional: true,
      run: async (): Promise<StepResult> => {
        const result = (opts.unwireProxyFn ?? unwireProxy)({ log });
        for (const error of result.errors) log(`      ! ${error.agent}: ${error.message}`);
        return { kind: "ok", status: result.errors.length === 0 ? "unwired" : "partly unwired" };
      },
    },
    {
      title: "Remove the proxy supervisor",
      optional: true,
      run: async (): Promise<StepResult> => {
        const result = await (opts.uninstallSupervisorFn ?? uninstallSupervisor)();
        return { kind: "ok", status: result.detail };
      },
    },
    {
      title: "Stop the proxy",
      optional: true,
      run: async (): Promise<StepResult> => {
        if (!cloudMode) {
          // A container, not a host process. Step 5 takes it down with
          // the rest of the stack; signalling a pid from a container's
          // health body would name a process in another namespace.
          return { kind: "skip", reason: "local mode — the proxy is a container" };
        }
        const result = await (opts.stopProxyFn ?? stopProxy)();
        log(`      ${result.detail}`);
        // A proxy we would not or could not stop is a warning, never a
        // tick: it is still holding the user's API key.
        return result.stopped || !result.wasRunning
          ? { kind: "ok", status: result.detail }
          : { kind: "warn", message: result.detail };
      },
    },
    ...adapterSteps,
    {
      title: "Stop containers and remove volumes",
      run: async (): Promise<StepResult> => {
        if (cloudMode) {
          return { kind: "skip", reason: "cloud mode — there is no local stack" };
        }
        const bin = await (opts.resolveComposeBinFn ?? resolveComposeBin)();
        await (opts.composeDownFn ?? composeDown)(bin, runtimeDir(), true);
        return { kind: "ok", status: "removed" };
      },
    },
  ]);

  process.stdout.write(
    "\nKlio is uninstalled. ~/.klio/runtime/ is left in place; remove it manually if you wish.\n",
  );
}
