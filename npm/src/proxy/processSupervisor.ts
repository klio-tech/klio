// The Docker-free half of `klio proxy ensure`.
//
// Local mode revives the proxy with `docker compose up -d proxy`. Cloud
// mode has no compose file and no daemon, so it spawns the CLI's own
// `proxy serve` detached. `ensure`'s contract is unchanged either way:
// probe first, revive only on failure, exit 0 when the proxy answers and
// 1 when it cannot be fixed.
//
// NOTHING HERE RECORDS A PID, deliberately. An earlier version wrote
// ~/.klio/proxy.pid, and its own comment admitted nothing read it back:
// the EADDRINUSE loser of a concurrent `ensure` race wrote its pid there
// and exited a moment later, so the file routinely named a process that
// no longer existed. The one attempt to USE it — gating revival on
// `kill(pid, 0)` — was reverted after a recycled pid permanently blocked
// revival on a live machine.
//
// The question a pid file was reaching for ("is our proxy running, and
// which process is it?") is answered instead by the proxy's own
// `/__klio/health` body, which reports `runtime: "node"`, its pid, and a
// fingerprint of the config it booted with. That is evidence from the
// process itself rather than a stale note about it, and it is what
// `klio proxy stop` (../proxy/stop.ts) requires before signalling
// anything. `pidFilePath` survives only so `klio uninit` can delete the
// file an older install left behind.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where older installs recorded the proxy pid. Nothing writes it now; `klio uninit` removes it. */
export function pidFilePath(home: string = homedir()): string {
  return join(home, ".klio", "proxy.pid");
}

export type SpawnProxyOptions = {
  cliPath: string;
  spawnImpl?: typeof spawn;
};

/**
 * Start `klio proxy serve` as a detached background process and return
 * its pid.
 *
 * The pid is returned for LOGGING ONLY. It proves the OS forked a
 * process, not that a proxy is listening: `server.listen()`'s
 * EADDRINUSE arrives asynchronously inside the child, long after the
 * parent has its pid. Every caller must confirm with a health probe —
 * `ensure` (../commands/proxy.ts) and `wireProxyStack`
 * (../commands/initCloud.ts) both do.
 */
export function spawnProxy(opts: SpawnProxyOptions): number {
  const doSpawn = opts.spawnImpl ?? spawn;
  // Detached + unref so the proxy outlives the `ensure` invocation that
  // started it — the supervisor fires every 60s and must not hold it.
  const child = doSpawn(process.execPath, [opts.cliPath, "proxy", "serve"], {
    detached: true,
    stdio: "ignore",
  });
  // Defensive, not currently load-bearing: `process.execPath` is always
  // a valid binary and a bad `cliPath` surfaces as a normal nonzero
  // child exit rather than a spawn-level `'error'` event. Listening
  // anyway means a future change to how the child is launched (e.g. a
  // shell wrapper, a different argv[0]) can't turn into an unhandled
  // 'error' event and crash the `ensure` process that called us.
  child.on("error", () => {});
  const pid = child.pid ?? 0;
  child.unref();
  return pid;
}
