// Turn the local proxy OFF, with proof of ownership.
//
// The proxy is spawned `detached` + `unref()`ed (processSupervisor.ts),
// which is what lets it outlive the 60-second `ensure` tick that started
// it — and also what makes it survive everything else, including `klio
// uninit`, until the machine reboots. That survivor is not inert:
// `startProxy` reads the cloud config exactly ONCE at boot and the
// recaller closes over the key it found, so an `uninit` → rotate key →
// `init` cycle leaves the OLD process holding port 8787 and
// authenticating every recall and capture with a REVOKED key. The new
// `proxy serve` loses the EADDRINUSE race, the post-spawn probe goes
// green against the survivor, and init prints "✓ Proxy on" while
// fail-open silently degrades the product to "no injection, ever".
//
// So there has to be a way to stop it — and stopping it means sending a
// signal to a pid, which is the most dangerous thing in this codebase.
// TWO things are NOT proof that a pid is ours:
//
//   * `kill(pid, 0)` succeeding. Pids are recycled; this was already
//     adjudicated once, when a coincidental `sleep 300` inheriting the
//     recorded pid permanently blocked proxy revival.
//   * Something answering `/__klio/health` with `{"status":"ok"}`. The
//     LOCAL stack's proxy is a container: its pid lives in another
//     namespace, and the same number on the host is an unrelated
//     process. Signalling it would be a foot-gun of our own making.
//
// The proof used here is the health body identifying itself as this
// package's Node server: `runtime: "node"` (see {@link ProxyHealth} —
// the Python proxy never emits it) plus a plausible `pid`. Anything
// else is reported and left strictly alone.

import { PROXY_PORT } from "./constants.js";
import type { ProbeResult } from "./supervisor.js";
import { probeProxy } from "./supervisor.js";

/**
 * What we tell a user to run when we will not act for them.
 *
 * DIAGNOSTIC, NOT DESTRUCTIVE, and that distinction is the whole point.
 * The obvious one-liner, `kill $(lsof -ti tcp:8787)`, selects every
 * process with the port open — the listener AND every connected client.
 * Measured with the proxy up and one client attached, `lsof -ti
 * tcp:8787` returned two pids, so pasting that kill also kills the
 * user's coding agent. This module refuses to automate port→pid→kill
 * precisely because a bare pid cannot prove ownership; handing the user
 * the same unsound step to run by hand would just move the blast radius
 * onto them. `-sTCP:LISTEN` narrows it to the listener, `-nP` keeps the
 * output readable, and the decision stays with the person who can see
 * the process name.
 */
const LISTENER_DIAGNOSTIC = `lsof -nP -iTCP:${PROXY_PORT} -sTCP:LISTEN`;

/** How long to wait for a SIGTERM to take effect before escalating. */
const TERM_GRACE_MS = 3000;

/** How long to wait after SIGKILL before giving up and reporting failure. */
const KILL_GRACE_MS = 2000;

/** Gap between "is it gone yet" checks. */
const POLL_INTERVAL_MS = 100;

export type StopProxyResult = {
  /** True only when a proxy WAS running and is now provably gone. */
  stopped: boolean;
  /** True when nothing was listening in the first place — success, not failure. */
  wasRunning: boolean;
  /** Human-readable outcome, always populated. */
  detail: string;
};

export type StopProxyOptions = {
  /** Injected by tests and by callers probing a non-default URL. */
  probeImpl?: () => Promise<ProbeResult>;
  /** Injected by tests. Production sends real signals. */
  killImpl?: (pid: number, signal: NodeJS.Signals) => void;
  sleepImpl?: (ms: number) => Promise<void>;
};

/**
 * Stop the proxy answering on the loopback port, if it is ours.
 *
 * Never throws: this is called from `klio uninit`, the escape hatch that
 * has to work when everything else is broken, so every failure is a
 * described result rather than an exception.
 */
export async function stopProxy(opts: StopProxyOptions = {}): Promise<StopProxyResult> {
  const probe = opts.probeImpl ?? (() => probeProxy());
  const kill = opts.killImpl ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const first = await probe();
  // "Nothing to stop" is a claim about the PORT, not about health. It
  // used to be `!first.alive`, which returned here for every responder
  // that was not a healthy Klio proxy — so a dev server on the port was
  // reported as "not running (unhealthy)" with exit 0, and the arm
  // below that exists to name a foreign listener was unreachable by
  // construction. `responded` is the question actually being asked.
  if (!first.responded) {
    return { stopped: false, wasRunning: false, detail: `not running (${first.detail})` };
  }

  const health = first.health ?? {};
  if (health.runtime !== "node") {
    // Three things can answer here, and telling the user the wrong one
    // is worse than saying nothing. The containerised Python proxy
    // reports its named `upstreams`; a Klio proxy from BEFORE the
    // health body carried an identity reports `{"status":"ok"}` and
    // nothing else. (Found live: an older proxy was classified as "not
    // a Klio proxy" and the user was pointed at `klio down`, which does
    // not touch it — so it survived, the new proxy lost the EADDRINUSE
    // race, and the probe went green against the OLD process.)
    const isContainer = health.upstreams !== undefined || health.upstream !== undefined;
    return {
      stopped: false,
      wasRunning: true,
      detail: isContainer
        ? "the proxy on this port is the local Docker stack's container, not a host " +
          "process — `klio down` is the command that stops it. Left it alone."
        : health.status === "ok"
          ? `an older Klio proxy is holding this port. Versions before 0.9.4 do not ` +
            `report their pid, so it cannot be stopped safely from here — find it with ` +
            `\`${LISTENER_DIAGNOSTIC}\` and end that process (it also goes away on ` +
            `reboot), then re-run this.`
          : `something is answering on the proxy port, but it is not a Klio proxy ` +
            `(${first.detail}) — left it alone. \`${LISTENER_DIAGNOSTIC}\` says what it is; ` +
            `until it is gone, the Klio proxy cannot bind the port.`,
    };
  }

  const pid = typeof health.pid === "number" && Number.isInteger(health.pid) && health.pid > 0
    ? health.pid
    : null;
  if (pid === null) {
    return {
      stopped: false,
      wasRunning: true,
      detail:
        "the proxy is answering but did not report its pid, so it cannot be stopped " +
        `safely from here — \`${LISTENER_DIAGNOSTIC}\` says which process holds the port.`,
    };
  }
  if (pid === process.pid) {
    // Only reachable if this CLI process IS the proxy (`klio proxy
    // serve` in one terminal being asked to stop itself). Signalling
    // ourselves mid-command would be a confusing way to exit.
    return {
      stopped: false,
      wasRunning: true,
      detail: "this process is the proxy — stop it with Ctrl-C rather than `klio proxy stop`",
    };
  }

  // SIGTERM first: `proxy serve` holds only a listening socket, so the
  // default handler exiting the process is exactly the right behaviour
  // and nothing is left half-written. SIGKILL is the escalation for a
  // wedged process, not the opening move.
  try {
    kill(pid, "SIGTERM");
  } catch (err) {
    return {
      stopped: false,
      wasRunning: true,
      detail: `could not signal the proxy (pid ${pid}): ${messageOf(err)}`,
    };
  }

  if (await waitUntilGone(probe, sleep, TERM_GRACE_MS)) {
    return { stopped: true, wasRunning: true, detail: `stopped the proxy (pid ${pid})` };
  }

  try {
    kill(pid, "SIGKILL");
  } catch (err) {
    return {
      stopped: false,
      wasRunning: true,
      detail: `the proxy (pid ${pid}) ignored SIGTERM and could not be killed: ${messageOf(err)}`,
    };
  }

  if (await waitUntilGone(probe, sleep, KILL_GRACE_MS)) {
    return { stopped: true, wasRunning: true, detail: `stopped the proxy (pid ${pid}, needed SIGKILL)` };
  }

  return {
    stopped: false,
    wasRunning: true,
    detail:
      `signalled the proxy (pid ${pid}) but something is still answering on the port — ` +
      "another listener may have taken it over",
  };
}

/**
 * Liveness is re-read from the PORT, not from the pid.
 *
 * "The pid is gone" and "the port is free" are different claims, and the
 * one that matters is the port: a second proxy racing to bind it, or an
 * unrelated listener taking it over, leaves the user exactly as
 * unable to reach a model as before. Polling the probe answers the
 * question the caller actually asked.
 *
 * And "free" means NOTHING ANSWERS — `responded`, not `alive`. Reading
 * `alive` here would call the port free the moment an unrelated
 * listener took it over, which is the same conflation that made a dev
 * server on 8787 report as "not running".
 */
async function waitUntilGone(
  probe: () => Promise<ProbeResult>,
  sleep: (ms: number) => Promise<void>,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    const again = await probe();
    if (!again.responded) return true;
    if (Date.now() >= deadline) return false;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
