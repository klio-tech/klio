// `klio proxy <ensure|status>` — the command the supervisor runs.
//
// Kept separate from `klio doctor` because the two have different
// audiences and different failure behaviour. `doctor` talks to a human
// and fixes everything it can. `ensure` is called every 60 seconds by
// launchd/systemd, prints almost nothing, and only ever does one thing:
// if the proxy is not answering, bring it back.
//
// Exit codes matter here — they are the supervisor's only signal:
//   0  proxy is answering (either it already was, or we revived it)
//   1  proxy is not answering and we could not fix it

import { runtimeDir } from "../compose.js";
import { composeUpService, resolveComposeBin } from "../docker.js";
import { PROXY_SERVICE } from "../proxy/constants.js";
import { probeProxy } from "../proxy/supervisor.js";

export type ProxyCommandOptions = {
  args: string[];
  log?: (line: string) => void;
};

export async function runProxyCommand(opts: ProxyCommandOptions): Promise<number> {
  const log = opts.log ?? ((line: string) => process.stdout.write(line + "\n"));
  const sub = opts.args[0] ?? "status";

  switch (sub) {
    case "ensure":
      return ensure(log);
    case "status":
      return status(log);
    default:
      process.stderr.write(
        `klio proxy: unknown subcommand: ${sub}\nusage: klio proxy <ensure|status>\n`,
      );
      return 2;
  }
}

/**
 * Bring the proxy back if it is not answering.
 *
 * Idempotent and cheap in the common case: one HTTP GET against
 * loopback, then nothing. The expensive path (resolving docker compose,
 * starting a service) only runs when the probe fails, which is what
 * makes it safe to schedule every minute.
 */
async function ensure(log: (line: string) => void): Promise<number> {
  const first = await probeProxy();
  if (first.alive) return 0;

  log(`klio proxy: not answering (${first.detail}) — restarting`);

  try {
    const bin = await resolveComposeBin();
    // `up -d --no-deps <service>` rather than `restart`: restart is a
    // no-op when the container does not exist at all, which is exactly
    // the state after a reboot where Docker started fresh.
    await composeUpService(bin, runtimeDir(), PROXY_SERVICE);
  } catch (err) {
    log(`klio proxy: restart failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // Give the container a moment to bind. The proxy has no dependencies
  // to wait on, so this is short — but not zero, because reporting
  // failure immediately after a successful `up` would make the
  // supervisor thrash.
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(500);
    const probe = await probeProxy();
    if (probe.alive) {
      log("klio proxy: back up");
      return 0;
    }
  }

  log("klio proxy: restarted but still not answering — run `klio doctor`");
  return 1;
}

/** One-line liveness report for humans and scripts. */
async function status(log: (line: string) => void): Promise<number> {
  const probe = await probeProxy();
  log(probe.alive ? `klio proxy: ${probe.detail}` : `klio proxy: down (${probe.detail})`);
  return probe.alive ? 0 : 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
