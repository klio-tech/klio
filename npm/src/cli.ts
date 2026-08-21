// CLI dispatcher.
//
// Hand-rolled argv parsing — no commander/yargs/etc — because the
// surface is small (5 subcommands × at most 3 flags each) and we
// want zero runtime dependencies. Adding a 200KB CLI library to
// parse "klio init --email foo" doesn't pay for itself.

import { init } from "./commands/init.js";
import { parseInitArgs } from "./initArgs.js";
import { status } from "./commands/status.js";
import { down, uninstall } from "./commands/down.js";
import { runUpdate } from "./commands/update.js";
import { packageVersion } from "./version.js";

const SUBCOMMANDS = ["init", "status", "down", "uninstall", "uninit", "doctor", "proxy", "update", "configure", "hook", "version"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printUsage();
    process.exit(2);
  }

  const sub = argv[0];
  if (sub === "-v" || sub === "--version") {
    process.stdout.write(packageVersion() + "\n");
    return;
  }
  if (sub === "-h" || sub === "--help") {
    printUsage();
    return;
  }

  if (!isSubcommand(sub)) {
    process.stderr.write(`klio: unknown subcommand: ${sub}\n`);
    printUsage();
    process.exit(2);
  }

  const rest = argv.slice(1);
  switch (sub) {
    case "init":
      await init(parseInitArgs(rest));
      return;
    case "status":
      await status();
      return;
    case "down":
      await down();
      return;
    case "uninstall":
      await uninstall();
      return;
    case "uninit": {
      // Scoped to the proxy wiring — NOT the same as `uninstall`,
      // which deletes memory. Someone reaching for "stop routing my
      // traffic" must not lose their data as a side effect.
      const { uninit } = await import("./commands/uninit.js");
      process.exitCode = await uninit(parseUninitArgs(rest));
      return;
    }
    case "doctor": {
      const { doctor } = await import("./commands/doctor.js");
      process.exitCode = await doctor(parseDoctorArgs(rest));
      return;
    }
    case "proxy": {
      // Machine-facing: this is what the launchd/systemd unit runs
      // every 60s. Its exit code is the supervisor's only signal.
      const { runProxyCommand } = await import("./commands/proxy.js");
      process.exitCode = await runProxyCommand({ args: rest });
      return;
    }
    case "update":
      await runUpdate({ args: rest });
      return;
    case "configure": {
      const { runConfigure } = await import("./commands/configure.js");
      await runConfigure({ args: rest });
      return;
    }
    case "hook": {
      // Invoked by Claude Code (and compatible agents) on lifecycle
      // events in CLOUD mode, with the event JSON piped on stdin. This is
      // a machine-facing command, not a user-facing one. It is SOFT-FAIL:
      // it never throws and exits 0 even when unconfigured, so a stray
      // hook can never block the user's session.
      const { runHook, readStdin } = await import("./commands/hook.js");
      const stdin = await readStdin();
      process.exitCode = await runHook(rest[0] ?? "", { stdin });
      return;
    }
    case "version":
      process.stdout.write(packageVersion() + "\n");
      return;
  }
}

function isSubcommand(s: unknown): s is Subcommand {
  return typeof s === "string" && (SUBCOMMANDS as readonly string[]).includes(s);
}

function parseUninitArgs(rest: string[]): { keepRunning?: boolean } {
  const opts: { keepRunning?: boolean } = {};
  for (const a of rest) {
    if (a === "--keep-running") {
      opts.keepRunning = true;
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(
        "usage: klio uninit [--keep-running]\n\n" +
          "Removes the compression-proxy wiring from your agents' configs and\n" +
          "stops the proxy. Your memory, MCP server and hooks are untouched —\n" +
          "use `klio uninstall` for those.\n\n" +
          "  --keep-running   leave the proxy running; only undo the config\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`klio uninit: unknown flag: ${a}\n`);
      process.exit(2);
    }
  }
  return opts;
}

function parseDoctorArgs(rest: string[]): { skipEndToEnd?: boolean; dryRun?: boolean } {
  const opts: { skipEndToEnd?: boolean; dryRun?: boolean } = {};
  for (const a of rest) {
    if (a === "--offline") {
      opts.skipEndToEnd = true;
    } else if (a === "--dry-run") {
      opts.dryRun = true;
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(
        "usage: klio doctor [--offline] [--dry-run]\n\n" +
          "Checks the compression proxy end to end and repairs what it can.\n\n" +
          "  --offline   skip the live request to api.anthropic.com\n" +
          "  --dry-run   report problems without fixing them\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`klio doctor: unknown flag: ${a}\n`);
      process.exit(2);
    }
  }
  return opts;
}

function printUsage(): void {
  const v = packageVersion();
  process.stdout.write(`klio ${v}

Persistent memory for your AI coding agents — local-first, encrypted, MCP-native.

usage: klio <command> [options]

commands:
  init        Set up the local stack and wire your AI agents (Claude Code, Cursor)
  status      Show what's running, where, and as whom
  update      Re-prompt provider/curator/agents, OR upgrade the stack to a new release.
              Stack-wide flags: --check, --to-latest, --to-version <X>, --watch.
              --watch runs a long-lived host-side process that applies background
              auto-updates the bridge has detected (no docker-in-docker needed).
  configure   Tweak runtime settings (auto-update mode, claim email, etc.)
  doctor      Check the compression proxy end to end, and repair what it can
  uninit      Remove the compression-proxy wiring (memory + MCP are untouched)
  proxy       Proxy control: \`klio proxy status|serve|stop|ensure\`.
              Kill switches, saved and applied at once:
              \`klio proxy inject off\`, \`klio proxy capture off\`
  down        Stop the stack (data is preserved)
  uninstall   Stop and delete all data; restore agent configs from backup
  version     Print the package version

flags:
  -h, --help     Print this message
  -v, --version  Print the package version

learn more: https://klio.tech
`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\nklio: ${message}\n`);
  process.exit(1);
});
