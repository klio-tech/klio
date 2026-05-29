// CLI dispatcher.
//
// Hand-rolled argv parsing — no commander/yargs/etc — because the
// surface is small (5 subcommands × at most 3 flags each) and we
// want zero runtime dependencies. Adding a 200KB CLI library to
// parse "klio init --email foo" doesn't pay for itself.

import { init } from "./commands/init.js";
import { status } from "./commands/status.js";
import { down, uninstall } from "./commands/down.js";
import { runUpdate } from "./commands/update.js";
import { packageVersion } from "./version.js";

const SUBCOMMANDS = ["init", "status", "down", "uninstall", "update", "configure", "hook", "version"] as const;
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

function parseInitArgs(rest: string[]): Parameters<typeof init>[0] {
  const opts: Parameters<typeof init>[0] = {
    imageTag: packageVersion(),
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--email") {
      opts.email = expectValue(rest, ++i, "--email");
    } else if (a === "--image-tag") {
      opts.imageTag = expectValue(rest, ++i, "--image-tag");
    } else if (a === "--engine-url") {
      opts.engineURL = expectValue(rest, ++i, "--engine-url");
    } else if (a === "--skip-provider") {
      opts.skipProvider = true;
    } else if (a === "--skip-wow") {
      opts.skipWow = true;
    } else if (a === "--skip-community") {
      opts.skipCommunity = true;
    } else if (a === "--quiet") {
      opts.quiet = true;
    } else if (a === "--cloud") {
      // Force the hosted-brain flow, skipping the mode prompt. Mutually
      // exclusive with --local; the last one on the command line wins,
      // mirroring standard getopt "last flag" semantics.
      opts.mode = "cloud";
    } else if (a === "--local") {
      // Force the self-hosted Docker flow, skipping the mode prompt.
      opts.mode = "local";
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(
        "usage: klio init [--cloud | --local] [--email <addr>] [--image-tag <tag>]\n" +
          "                 [--engine-url <url>] [--skip-provider] [--skip-wow]\n" +
          "                 [--skip-community] [--quiet]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`klio init: unknown flag: ${a}\n`);
      process.exit(2);
    }
  }
  return opts;
}

function expectValue(argv: string[], idx: number, flag: string): string {
  const v = argv[idx];
  if (v === undefined || v.startsWith("--")) {
    process.stderr.write(`${flag} requires a value\n`);
    process.exit(2);
  }
  return v;
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
