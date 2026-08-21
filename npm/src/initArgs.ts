// Flag parsing for `klio init`.
//
// Its own module, not part of `cli.ts`, because `cli.ts` runs `main()` on
// import — a test that imported the parser from there would execute the CLI
// as a side effect (and did: it printed usage and exited 2). Splitting the
// pure function out keeps the entrypoint's top-level side effect where it
// belongs while making the parser directly testable.

import type { init } from "./commands/init.js";
import { packageVersion } from "./version.js";

/**
 * Parse the flags after `klio init`.
 *
 * Exported for tests: flag parsing is hand-rolled (no argv library), so the
 * value-consuming flags are exactly where an off-by-one silently eats the
 * next flag as a value.
 */
export function parseInitArgs(rest: string[]): Parameters<typeof init>[0] {
  const opts: Parameters<typeof init>[0] = {
    imageTag: packageVersion(),
    // Environment first, flag second (the flag overwrites below). argv is
    // world-readable via `ps` on most systems, so an agent or CI runner
    // handling a real key should prefer the variable; `--key` stays for
    // interactive one-liners where that exposure is already accepted.
    apiKey: process.env.KLIO_API_KEY,
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
    } else if (a === "--key") {
      // Cloud only. Supplying a key skips the masked prompt, which is the
      // one interactive gate in cloud mode — this is what lets a coding
      // agent run `klio init --cloud` for the user from the connect screen.
      opts.apiKey = expectValue(rest, ++i, "--key");
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
        "usage: klio init [--cloud | --local] [--key <api-key>] [--email <addr>]\n" +
          "                 [--image-tag <tag>] [--engine-url <url>] [--skip-provider]\n" +
          "                 [--skip-wow] [--skip-community] [--quiet]\n" +
          "\n" +
          "  --key <api-key>  Cloud mode: verify this key instead of prompting for\n" +
          "                   one, making `klio init --cloud` fully non-interactive.\n" +
          "                   Also read from KLIO_API_KEY, which --key overrides.\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`klio init: unknown flag: ${a}\n`);
      process.exit(2);
    }
  }
  return opts;
}

/**
 * Read the value that follows a value-taking flag.
 *
 * A value that itself looks like a flag is refused rather than consumed:
 * `klio init --key --cloud` is a mistake, and silently treating "--cloud" as
 * the API key would send it to /verify and blame the user's key.
 */
export function expectValue(
  argv: string[],
  idx: number,
  flag: string,
): string {
  const v = argv[idx];
  if (v === undefined || v.startsWith("--")) {
    process.stderr.write(`${flag} requires a value\n`);
    process.exit(2);
  }
  return v;
}
