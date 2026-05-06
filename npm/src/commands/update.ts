/**
 * `klio update` — re-run a slice of init without rebuilding the
 * whole stack.
 *
 * Subcommands:
 *   `klio update`          — menu picker over the three slices
 *   `klio update curator`  — re-prompt curator schedule + model
 *   `klio update agents`   — re-detect + re-wire AI agents
 *   `klio update provider` — change LLM provider without re-init
 *
 * E1 wires the routing skeleton + menu picker. The block bodies
 * (curator / agents / provider) and the `--run-now` flag arrive
 * in E2-E5.
 */

import { prompt } from "../prompt.js";


export type UpdateTarget = "menu" | "curator" | "agents" | "provider" | "unknown";


/** Parse the residual argv after `klio update`. */
export function parseUpdateTarget(args: readonly string[]): UpdateTarget {
  if (args.length === 0) return "menu";
  const first = args[0];
  if (first === "curator" || first === "agents" || first === "provider") {
    return first;
  }
  return "unknown";
}


export type UpdateOptions = {
  /** Residual argv after `klio update` (e.g. ["curator", "--run-now"]). */
  args: readonly string[];
};


export async function runUpdate(opts: UpdateOptions): Promise<void> {
  const target = parseUpdateTarget(opts.args);

  if (target === "unknown") {
    process.stderr.write(
      `klio update: unknown target ${JSON.stringify(opts.args[0])}\n` +
        `Valid targets: curator, agents, provider, or no argument for menu.\n`,
    );
    process.exit(1);
  }

  const resolved = target === "menu" ? await pickFromMenu() : target;
  if (resolved === null) {
    process.stdout.write("Cancelled.\n");
    return;
  }

  switch (resolved) {
    case "curator":
      await runUpdateCurator(opts);
      return;
    case "agents":
      await runUpdateAgents(opts);
      return;
    case "provider":
      await runUpdateProvider(opts);
      return;
  }
}


/** Show the four-option picker. Returns the chosen target or null on cancel. */
async function pickFromMenu(): Promise<"curator" | "agents" | "provider" | null> {
  process.stdout.write(
    "\nWhat would you like to change?\n" +
      "  1) Provider + model picks\n" +
      "  2) Curator schedule + model\n" +
      "  3) Re-wire AI agents (re-runs adapter detection)\n" +
      "  4) Cancel\n",
  );
  const answer = await prompt({ message: "Choice", default: "1" });
  const trimmed = answer.trim();
  switch (trimmed) {
    case "1":
    case "":
      return "provider";
    case "2":
      return "curator";
    case "3":
      return "agents";
    case "4":
      return null;
    default:
      process.stderr.write(
        `Unknown choice ${JSON.stringify(trimmed)} — cancelling.\n`,
      );
      return null;
  }
}


// --- Block bodies (stubs — fleshed out in E2/E3/E4) ----------------


async function runUpdateCurator(_opts: UpdateOptions): Promise<void> {
  process.stdout.write(
    "klio update curator: not yet implemented (lands in v0.5.0 / Task E2).\n",
  );
}


async function runUpdateAgents(_opts: UpdateOptions): Promise<void> {
  process.stdout.write(
    "klio update agents: not yet implemented (lands in v0.5.0 / Task E3).\n",
  );
}


async function runUpdateProvider(_opts: UpdateOptions): Promise<void> {
  process.stdout.write(
    "klio update provider: not yet implemented (lands in v0.5.0 / Task E4).\n",
  );
}
