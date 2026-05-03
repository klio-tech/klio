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

export async function down(): Promise<void> {
  banner("Stopping Klio");
  const bin = await resolveComposeBin();
  const start = Date.now();
  await composeDown(bin, runtimeDir(), false);
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
