// The Docker-free half of `klio proxy ensure`.
//
// Local mode revives the proxy with `docker compose up -d proxy`. Cloud
// mode has no compose file and no daemon, so it spawns the CLI's own
// `proxy serve` detached and remembers the pid. `ensure`'s contract is
// unchanged either way: probe first, revive only on failure, exit 0 when
// the proxy answers and 1 when it cannot be fixed.
//
// The pid file is best-effort bookkeeping only. It exists so `ensure`
// does not spawn a second proxy on top of one that is already coming
// up; it is NEVER treated as proof the proxy is healthy — a pid can be
// recycled by an unrelated process, so only the health probe (in
// ../commands/proxy.ts) gets to decide "is it up".

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function pidFilePath(home: string = homedir()): string {
  return join(home, ".klio", "proxy.pid");
}

/** Signal 0 tests for existence without delivering a signal. */
export function isProxyRunning(
  pid: number,
  killImpl: (p: number, s: number) => void = process.kill.bind(process),
): boolean {
  try {
    killImpl(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read back the pid `spawnProxy` recorded, if any. Never throws — a
 * missing or malformed pid file just means "no bookkeeping available",
 * which `ensure` treats the same as "no pid on record" rather than an
 * error.
 */
export function readPid(
  path: string = pidFilePath(),
  readImpl: (p: string) => string = (p) => readFileSync(p, "utf8"),
): number | null {
  let raw: string;
  try {
    raw = readImpl(path);
  } catch {
    return null;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export type SpawnProxyOptions = {
  cliPath: string;
  spawnImpl?: typeof spawn;
  writeFileImpl?: (path: string, data: string) => void;
  home?: string;
};

export function spawnProxy(opts: SpawnProxyOptions): number {
  const doSpawn = opts.spawnImpl ?? spawn;
  const write =
    opts.writeFileImpl ??
    ((p: string, d: string) => {
      // `~/.klio` may not exist on a fresh machine — create it before
      // writing rather than let the pid write be the thing that fails.
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, d, "utf8");
    });
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
  // A failure to record the pid must not stop the proxy from being
  // spawned or `ensure` from reporting the truth of the health probe —
  // the pid file is bookkeeping, not the source of truth.
  try {
    write(pidFilePath(opts.home), String(pid));
  } catch {
    // non-fatal — see comment above.
  }
  return pid;
}
