// `klio down` — stop the stack without deleting any data.
//
// `klio uninstall` — stop + delete volumes (postgres, engine KMS,
// bridge keychain, redis AOF). Irreversible. Also restores Claude
// Code/Cursor configs from their backups.
//
// Why two separate commands: `down` is the everyday "I'm rebooting,
// give me my CPU back" action; `uninstall` is the rare "purge
// everything" action. Conflating them risks accidental data loss.

import { banner, ok, runSteps } from "../ui.js";
import { composeDown, resolveComposeBin } from "../docker.js";
import { runtimeDir } from "../compose.js";
import { allAdapters } from "../adapters/types.js";
import { readCloudConfig } from "../cloudConfig.js";
import { stopProxy } from "../proxy/stop.js";

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

export async function uninstall(): Promise<void> {
  banner("Uninstalling Klio");

  // One step per adapter, generated from the canonical registry.
  // Adding a new agent in `allAdapters()` extends uninstall coverage
  // automatically — no edit here required.
  const adapterSteps = allAdapters().map((adapter) => ({
    title: `Restore ${adapter.name()} config from backup`,
    optional: true,
    run: async () => {
      if (!adapter.installed()) {
        return { kind: "skip" as const, reason: "not installed" };
      }
      await adapter.uninstall();
      return { kind: "ok" as const, status: "restored" };
    },
  }));

  await runSteps([
    {
      title: "Stop containers and remove volumes",
      run: async () => {
        const bin = await resolveComposeBin();
        await composeDown(bin, runtimeDir(), true);
        return { kind: "ok", status: "removed" };
      },
    },
    ...adapterSteps,
  ]);

  process.stdout.write(
    "\nKlio is uninstalled. ~/.klio/runtime/ is left in place; remove it manually if you wish.\n",
  );
}
