// Cloud-mode `klio init` — the hosted-brain onboarding path.
//
// Where the LOCAL flow (src/commands/init.ts) runs six Docker-heavy
// phases, cloud mode is three short steps:
//
//   1. Prompt for the API key.
//   2. Verify it against the hosted brain's /verify endpoint.
//   3. Wire detected agents at the hosted MCP URL (X-Vex-Key +
//      X-Vex-Agent headers) — no Docker, no hooks, no engine.
//
// Then a final reference block. The flow reuses the shared UI helpers
// (phaseHeader / runSteps / narrate) so it looks consistent with the
// local path, just dramatically shorter.
//
// Pure-orchestration with the same DI style as init.ts: prompt + fetch
// + the Claude-CLI runner are all injectable so the unit suite drives
// the flow without a TTY or the network.

import { resolve } from "node:path";

import {
  CLOUD_BASE_URL,
  CLOUD_MCP_URL,
  deriveAgentId,
  maskKey,
  verifyCloudKey,
} from "../cloud.js";
import { configFingerprint, writeCloudConfig, type CloudConfig } from "../cloudConfig.js";
import { PROXY_PROBE_URL } from "../proxy/constants.js";
import { spawnProxy, type SpawnProxyOptions } from "../proxy/processSupervisor.js";
import { stopProxy, type StopProxyResult } from "../proxy/stop.js";
import {
  installSupervisor,
  probeProxy,
  resolveKlioCommand,
  type InstallResult,
  type ProbeResult,
} from "../proxy/supervisor.js";
import {
  describeTradeoffs,
  describeWiring,
  unwireProxy,
  wireProxy,
  type WireProxyOptions,
  type WireProxyResult,
} from "../proxy/wiring.js";
import { phaseHeader, phaseRecap } from "../ui.js";
import { packageVersion } from "../version.js";
import { prompt } from "../prompt.js";
import {
  wireCloudAgents,
  type ClaudeCliFn,
} from "./wireCloudAgents.js";

/**
 * Maximum API-key re-prompts before we abort cloud init. Generous for
 * honest paste mistakes, tight enough that a non-interactive stdin
 * (no TTY, EOF stream) doesn't spin forever. On exhaustion we print a
 * clear message and return — init does not crash.
 */
const MAX_KEY_ATTEMPTS = 5;

export type InitCloudOptions = {
  /**
   * Override the readline-backed prompt. Tests inject a scripted async
   * function; production leaves this undefined and the flow falls back
   * to the standard `prompt` helper (masked input for the key).
   */
  promptFn?: (opts: {
    message: string;
    default?: string;
    mask?: boolean;
  }) => Promise<string>;
  /**
   * Override the global `fetch` used by key verification. Production
   * leaves this undefined and uses the runtime fetch; tests pass a
   * recording stub so they never hit mcp.klio.tech.
   */
  fetchFn?: typeof fetch;
  /**
   * Override the Claude-CLI runner threaded into `wireCloudAgents`.
   * Tests inject a recording stub; production leaves it undefined and
   * the real `claude` binary is spawned.
   */
  claudeCliFn?: ClaudeCliFn;
  /**
   * Override the cloud-config persister. Production leaves this undefined
   * and the verified key + agent id are written to ~/.klio/config.json so
   * the `klio hook` passive-capture client can authenticate on every
   * Claude Code event (it runs as a bare subprocess with no other access
   * to the key). Tests inject a stub so the suite never writes to the real
   * home dir.
   */
  writeConfigFn?: (config: CloudConfig) => void;
  /** Single-line writer. Defaults to stdout. */
  log?: (line: string) => void;
};

/**
 * Run the cloud onboarding flow. Returns when wiring completes (or the
 * user aborts on an unrecoverable verification failure). Never throws
 * on a user-input branch; transport failures are surfaced as
 * messages, not exceptions.
 */
export async function initCloud(opts: InitCloudOptions = {}): Promise<void> {
  const log = opts.log ?? writeLine;
  const promptFn =
    opts.promptFn ??
    ((o: { message: string; default?: string; mask?: boolean }) =>
      prompt({ message: o.message, default: o.default, mask: o.mask }));

  // -----------------------------------------------------------------
  // Phase 1 / 2 · Verify your key
  // -----------------------------------------------------------------
  phaseHeader(1, 2, "Verify your key");
  log("");
  log("  Klio Cloud stores memory on our hosted brain — no Docker, no");
  log("  local engine. Paste the API key from your Klio Cloud dashboard.");
  log("");

  const key = await promptAndVerifyKey(promptFn, opts.fetchFn, log);
  if (!key) {
    // promptAndVerifyKey already explained why (missing scope, or the
    // attempt cap was hit). Cloud init can't proceed without a valid
    // key, so we return cleanly rather than wiring agents at a brain
    // they can't reach.
    return;
  }
  phaseRecap("Phase 1 done — key verified.");

  // -----------------------------------------------------------------
  // Phase 2 / 2 · Wire your agents
  // -----------------------------------------------------------------
  phaseHeader(2, 2, "Wire your agents");
  const agentId = deriveAgentId();

  // Persist the verified key + agent id BEFORE wiring so the capture hooks
  // we're about to install (and the `klio hook` client they invoke) can
  // authenticate immediately on the very first Claude Code event.
  const writeConfigFn = opts.writeConfigFn ?? writeCloudConfig;
  const cloudConfig: CloudConfig = { apiKey: key, agentId, baseUrl: CLOUD_BASE_URL };
  writeConfigFn(cloudConfig);

  log("");
  log(`    Pointing your agents at ${CLOUD_MCP_URL}`);
  log(`    Agent id: ${agentId}`);
  log("");

  const result = await wireCloudAgents({
    apiKey: key,
    agentId,
    log,
    claudeCliFn: opts.claudeCliFn,
  });

  for (const e of result.errored) {
    log(`  ! ${e.name}: ${e.message}`);
  }
  if (result.configured.length > 0) {
    // Say WHAT they are connected to. This line lists every agent that
    // got an MCP server entry, and it printed immediately above the
    // proxy offer — so a list ending in "codex" read as though all of
    // them were about to be, or already were, routed through the proxy.
    // They are two different integrations with two different reaches.
    log(`  ✓ ${result.configured.join(" + ")} — Klio MCP server connected`);
  } else if (result.skipped.length === 0 && result.errored.length === 0) {
    log("  — No MCP-capable agents found. Install Claude Code, Cursor, or");
    log("    Codex and re-run `klio init` to wire them up.");
  }
  phaseRecap("Phase 2 done — your agents are talking to Klio Cloud.");

  // -----------------------------------------------------------------
  // Offer the local proxy — opt-in, defaults to no.
  // -----------------------------------------------------------------
  // Detection reuses the SAME buckets `wireCloudAgents` already sorted
  // every detected adapter into (configured / skipped / errored — every
  // adapter for which `installed()` was true lands in exactly one of
  // them), so this is not a second detector; it is a read of the one
  // that already ran.
  const detectedNames = new Set<string>([
    ...result.configured,
    ...result.skipped,
    ...result.errored.map((e) => e.name),
  ]);
  const anyProxyableAgent =
    detectedNames.has("claude-code") || detectedNames.has("codex");

  // The trade-offs (MCP Tool Search, Remote Control) are only relevant
  // when we are about to ask — printed BEFORE the prompt so the user
  // decides with the costs in front of them, not after. Guarded on
  // `anyProxyableAgent` so a machine with nothing to offer the proxy to
  // sees no extra output, same as before this feature existed.
  if (anyProxyableAgent) {
    describeTradeoffs(log);
  }

  const proxyOffer = await maybeOfferProxy({
    ask: buildProxyAsk(promptFn),
    anyProxyableAgent,
    // A non-interactive stdin (CI, `npx klio init < /dev/null`, any
    // piped script) must never silently install a proxy, a supervisor
    // unit, and rewrite agent configs just because nobody was there to
    // read the prompt. `default: "y"` makes an EMPTY line accept, and a
    // closed/piped stdin resolves to an empty line the instant the
    // stream ends (see buildProxyAsk / prompt.ts's handleEnd) — so
    // without this check, non-interactive init would silently opt in.
    // Checked here rather than inside `maybeOfferProxy` so the answer-
    // parsing tests stay TTY-free; production is the only caller that
    // ever inspects `process.stdin` directly.
    isInteractive: process.stdin.isTTY === true,
    // The fingerprint of the config written moments ago is what lets
    // step 3 tell "the proxy I just started" from "a survivor of an
    // earlier init still holding 8787 with the key you rotated away
    // from" — the two are indistinguishable to a bare health probe.
    wire: () => wireProxyStack({ log, expectedFingerprint: configFingerprint(cloudConfig) }),
  });

  if (proxyOffer.enabled) {
    log("");
    log(`  ✓ Proxy on — routing model calls through ${PROXY_PROBE_URL}.`);
    log("    It forwards requests unchanged if anything goes wrong (fails");
    log("    open), so a proxy issue never blocks your agent. Turn it off");
    log("    any time with `klio uninit`.");
  } else if (proxyOffer.error) {
    log("");
    log(`  ! Could not turn on the proxy: ${proxyOffer.error}`);
    log("    Your agents are unaffected — re-run `klio init` to try again.");
  } else if (proxyOffer.skippedNonInteractive) {
    log("");
    log("  — Proxy skipped: no interactive terminal to ask (stdin isn't a");
    log("    TTY). Re-run `klio init` from a terminal to enable it, or turn");
    log("    it on later the same way.");
  } else if (anyProxyableAgent) {
    log("");
    log("  — Proxy left off. Enable it any time by re-running `klio init`.");
  }

  printReferenceBlock(log, result.configured, key);
}

/**
 * Inputs to `maybeOfferProxy` — deliberately narrow so tests never need
 * a TTY, a real filesystem, or a subprocess to exercise every branch.
 */
export type OfferProxyOptions = {
  ask: (prompt: string) => Promise<string>;
  anyProxyableAgent: boolean;
  wire: () => Promise<void>;
  /**
   * Whether stdin is attached to an interactive terminal. Defaults to
   * `true` when omitted so every test that predates this option (and
   * every test that isn't specifically about the TTY guard) keeps
   * exercising the answer-parsing/wiring logic unchanged. Production
   * (initCloud.ts) always passes `process.stdin.isTTY === true`
   * explicitly.
   *
   * When `false`, the offer is declined WITHOUT calling `ask` at all —
   * `default: "y"` (buildProxyAsk) makes an empty read resolve to
   * accept, and a non-interactive stdin (closed, piped, `/dev/null`)
   * resolves to an empty read the instant the stream ends. Reaching
   * `ask` at all on a non-interactive stdin would mean the default
   * silently wins with nobody there to have chosen it — installing a
   * proxy, a supervisor unit, and rewriting agent config as a side
   * effect nobody asked for. That is never acceptable as an implicit
   * outcome, so this check comes first and short-circuits the prompt
   * entirely.
   */
  isInteractive?: boolean;
};

/**
 * `enabled` is false because the user declined, the session was
 * non-interactive, or `wire()` threw — `error` and
 * `skippedNonInteractive` distinguish the three. Note that a
 * *supervisor* install failure specifically (step 2 of `wireProxyStack`)
 * does NOT show up here: it is non-fatal by design (proxy/supervisor.ts)
 * and is reported only through the `log()` lines `wireProxyStack` writes
 * while wiring, not through this result.
 */
export type OfferProxyResult = {
  enabled: boolean;
  error?: string;
  /** True when the offer was declined because stdin isn't a TTY — `ask` was never called. */
  skippedNonInteractive?: boolean;
};

/**
 * Offer the local proxy, defaulting to YES.
 *
 * The proxy is the only integration point that needs nothing from the
 * agent — no hook support, no SDK, nothing to configure — so a user who
 * skips it gets the weakest version of the product for no reason most
 * of the time. It fails open (proxy/wiring.ts, proxy/server.ts), is
 * supervised back to life every 60s, is healed by `klio doctor`, and
 * can be turned off in one command (`klio uninit`, or the standing kill
 * switches `klio proxy inject off` / `klio proxy capture off`) — the
 * safety net that used to justify defaulting to no has since shipped.
 * So this is opt-out: a bare Enter accepts.
 *
 * Answer parsing is intentionally narrow and exact-match, in both
 * directions:
 *   - Accept only on an EMPTY answer (the bare-Enter default) or an
 *     exact `y` / `yes` (any case).
 *   - Decline on everything else — that includes the explicit `n` /
 *     `no`, but ALSO any unrecognized text (`nope`, `sure`, `yep`,
 *     `yy`, `   `). A default-yes prompt has to fail toward the safer
 *     outcome when the input isn't a clean match; silently treating
 *     "anything that isn't an exact no" as a yes would mean garbled
 *     input (a fat-fingered paste, a stray keystroke) turns into an
 *     unrequested proxy install. No prefix matching either way, so
 *     "nope" is not mistaken for "no" and does not get special-cased
 *     into an accept by falling through a loose check.
 */
export async function maybeOfferProxy(
  opts: OfferProxyOptions,
): Promise<OfferProxyResult> {
  if (!opts.anyProxyableAgent) return { enabled: false };
  if (opts.isInteractive === false) {
    return { enabled: false, skippedNonInteractive: true };
  }
  // The claim here is scoped on purpose, and the scope is the whole
  // point of the question. Injection and capture now cover BOTH
  // Anthropic's /v1/messages and OpenAI's /v1/responses
  // (proxy/server.ts), so Codex is genuinely served. Claude Code is
  // NOT the reason to say yes: its hooks already inject and capture
  // regardless of auth mode, and on a Claude subscription it never
  // routes to a custom base URL at all — measured live, zero
  // connections reached a healthy proxy. Selling this as the way
  // Claude Code gets team context was selling a no-op.
  const raw = await opts.ask(
    "Route model calls through a local Klio proxy? Recommended if you use\n" +
      "Codex or your own agents — it's the only integration that needs\n" +
      "nothing from the agent (no hooks, no SDK). It appends your team's\n" +
      "context to each request (Anthropic's messages API and OpenAI's\n" +
      "/v1/responses, which is what Codex speaks) and captures the session\n" +
      "for grading. Claude Code does not need it: Klio's hooks already\n" +
      "inject and capture there, and on a Claude subscription it won't use\n" +
      "a custom base URL anyway. It does reroute model calls through a\n" +
      "local process on 127.0.0.1 — but it fails open, is auto-revived if\n" +
      "it dies, and you can turn it off any time (`klio uninit`, or\n" +
      "`klio proxy inject off` / `capture off`). [Y/n]: ",
  );
  // `raw === ""` catches ONLY the true bare-Enter case: prompt.ts
  // substitutes an empty line with `default: "y"` (buildProxyAsk)
  // before it ever reaches here, so in production `raw` is either that
  // substituted "y" or whatever the user actually typed — this branch
  // exists for callers/tests that hand `ask` a raw, unsubstituted
  // empty string directly. A line of pure whitespace is NOT the same
  // as bare-Enter (the user typed something), so it falls through to
  // the exact-match check below like any other non-empty input and
  // declines.
  const trimmed = raw.trim().toLowerCase();
  const accepted = raw === "" || trimmed === "y" || trimmed === "yes";
  if (!accepted) return { enabled: false };
  try {
    await opts.wire();
    return { enabled: true };
  } catch (err) {
    return { enabled: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Build the `ask` callback `maybeOfferProxy` calls, wired through the
 * real `prompt()` helper.
 *
 * The single, load-bearing thing this does is pass `default: "y"`.
 * Without SOME default, `prompt()` treats an empty line as invalid input
 * (prompt.ts: `if (!final && !opts.default)`) and loops back to read
 * another line — which breaks two ways:
 *
 *   - Interactive: a bare Enter re-prints "value required" and asks
 *     again, so the user can never simply hit Enter to accept — the
 *     headline requirement of this feature.
 *   - Non-interactive (piped/closed stdin): once the stream ends,
 *     `readLine()` resolves `""` immediately and forever (see
 *     prompt.ts's `handleEnd`), so the loop spins without ever
 *     yielding a value that satisfies `!final && !opts.default` —
 *     a genuine hang that would brick `npx klio init` under CI or any
 *     piped input.
 *
 * With `default: "y"`, an empty line resolves immediately to `"y"`,
 * which `maybeOfferProxy` already treats as an accept. Do NOT remove
 * this default to "fix" the non-interactive case — that is handled one
 * layer up, by `maybeOfferProxy`'s `isInteractive` check, which stops a
 * non-interactive stdin from ever reaching `ask` at all. Removing the
 * default here would just reintroduce the hang above for anyone who
 * DOES have a TTY and wants to bare-Enter accept.
 *
 * Exported (rather than inlined at the `initCloud` call site) so the
 * unit suite can drive this exact call shape through the REAL
 * `prompt()` implementation with a closed stream, instead of asserting
 * against a mocked `ask` that could never have caught this bug.
 */
export function buildProxyAsk(
  promptFn: (opts: {
    message: string;
    default?: string;
    mask?: boolean;
  }) => Promise<string>,
): (message: string) => Promise<string> {
  return (message: string) => promptFn({ message, default: "y" });
}

/** Inputs to `wireProxyStack`. Every collaborator is injectable for tests. */
export type WireProxyStackOptions = {
  log: (line: string) => void;
  wireProxyFn?: (opts: WireProxyOptions) => WireProxyResult;
  unwireProxyFn?: (opts: WireProxyOptions) => WireProxyResult;
  installSupervisorFn?: (
    klioCommand: string[],
  ) => Promise<InstallResult>;
  spawnProxyFn?: (opts: SpawnProxyOptions) => number;
  /**
   * Health probe used to confirm the proxy is actually answering after
   * `spawnProxy` returns. Defaults to the real `probeProxy` from
   * proxy/supervisor.ts, probing the real 127.0.0.1 proxy port. Tests
   * override this to point at a fake listener instead.
   */
  probeProxyFn?: () => Promise<ProbeResult>;
  /** Stops a survivor holding the port. Defaults to the real `stopProxy`. */
  stopProxyFn?: () => Promise<StopProxyResult>;
  /**
   * Fingerprint of the config this init just wrote (see
   * `configFingerprint` in cloudConfig.ts). When set, a proxy answering
   * with a DIFFERENT fingerprint is treated as a survivor of an earlier
   * init rather than as the proxy we started. Undefined disables the
   * check, which is only ever right for callers that have not written a
   * config at all.
   */
  expectedFingerprint?: string;
  resolveKlioCommandFn?: (
    argv1?: string,
    execPath?: string,
    version?: string,
  ) => string[];
  cliPath?: string;
  version?: string;
  /** Reprobe attempts after spawning, before declaring step 3 failed. */
  probeAttempts?: number;
  /** Delay between reprobe attempts, in ms. */
  probeIntervalMs?: number;
  /** Injectable delay. Defaults to a real `setTimeout`-backed sleep. */
  sleepFn?: (ms: number) => Promise<void>;
};

/**
 * Wire the local proxy in three steps — `wireProxy`, `installSupervisor`,
 * `spawnProxy` — in that order, and never leave the middle of that
 * sequence silently half-applied.
 *
 * The three steps have different failure weights:
 *
 *   1. `wireProxy` failing means some (or all) agent config could not be
 *      pointed at the proxy. Whatever DID succeed is undone with
 *      `unwireProxy` before the failure is reported — a machine where
 *      Claude Code got wired but Codex didn't is not an acceptable
 *      resting state.
 *   2. `installSupervisor` is documented (proxy/supervisor.ts) to never
 *      throw and to be non-fatal by design: a supervisor that fails to
 *      load means the proxy will not survive a reboot, but the proxy
 *      itself (step 3) still comes up and works right now. So a failed
 *      install is reported and we proceed — rolling back working agent
 *      wiring over a reboot-resilience gap would be a worse outcome for
 *      the user than the gap itself.
 *   3. `spawnProxy` failing — including SILENTLY, by returning a pid for
 *      a process that never actually binds the port — is the worst case
 *      this function can produce: agents would be pointed at 127.0.0.1
 *      with nothing listening. A returned pid proves nothing:
 *      `spawnProxy` (processSupervisor.ts) detaches a new process and
 *      returns its pid the instant the OS forks it, and its own
 *      `child.on("error")` listener only ever sees SPAWN-level failures
 *      (e.g. a missing binary) — never the child's own asynchronous
 *      `EADDRINUSE` from inside its `server.listen()`. So, exactly like
 *      this codebase's own `ensure()` (commands/proxy.ts) does after a
 *      revive, we reprobe after spawning and treat "still not
 *      answering" as this step's real failure signal. Wiring is rolled
 *      back with `unwireProxy` on either kind of failure (the spawn
 *      call throwing, or the reprobe never going green), so an agent is
 *      never left pointed at a dead port.
 *
 * `unwireProxy` is itself per-agent-isolated and can fail for one agent
 * while succeeding for another. Both rollback call sites inspect its
 * result: if the rollback was itself incomplete, the thrown message
 * says exactly which agent(s) are still pointed at the proxy rather
 * than unconditionally claiming a clean undo.
 */
export async function wireProxyStack(
  opts: WireProxyStackOptions,
): Promise<void> {
  const log = opts.log;
  const wireProxyFn = opts.wireProxyFn ?? wireProxy;
  const unwireProxyFn = opts.unwireProxyFn ?? unwireProxy;
  const installSupervisorFn = opts.installSupervisorFn ?? installSupervisor;
  const spawnProxyFn = opts.spawnProxyFn ?? spawnProxy;
  const probeProxyFn = opts.probeProxyFn ?? (() => probeProxy());
  const resolveKlioCommandFn = opts.resolveKlioCommandFn ?? resolveKlioCommand;
  const cliPath = opts.cliPath ?? resolve(process.argv[1] ?? "");
  // Mirrors commands/proxy.ts's `ensure()`: 10 attempts × 500ms ≈ 5s of
  // grace for the proxy to bind before we give up on it.
  const probeAttempts = opts.probeAttempts ?? 10;
  const probeIntervalMs = opts.probeIntervalMs ?? 500;
  const sleepFn =
    opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Step 1 — point every detected agent at the local proxy.
  const wiring = wireProxyFn({ log });
  describeWiring(wiring, log);
  if (wiring.errors.length > 0) {
    const detail = wiring.errors
      .map((e) => `${e.agent}: ${e.message}`)
      .join("; ");
    throw new Error(describeRollback(unwireProxyFn({ log }), `proxy wiring failed (${detail})`));
  }

  // Step 2 — install the supervisor. Non-fatal by design; see the
  // doc comment above for why this does not roll back step 1.
  const supervisor = await installSupervisorFn(
    resolveKlioCommandFn(process.argv[1], process.execPath, opts.version ?? packageVersion()),
  );
  log(
    supervisor.installed
      ? `    · ${supervisor.detail}`
      : `    ! ${supervisor.detail}`,
  );

  // Step 3 — start the proxy process itself, then confirm that the
  // thing now answering is the proxy WE started, running the config we
  // just wrote. See the doc comment above for why the pid alone is not
  // proof, and `configFingerprint` (cloudConfig.ts) for why "something
  // answers" is not proof either.
  //
  // At most two rounds: spawn → probe → (stop a survivor → spawn →
  // probe). Bounded deliberately — if a second, unstoppable process
  // keeps claiming the port, looping would just take longer to reach
  // the same rollback.
  const stopProxyFn = opts.stopProxyFn ?? (() => stopProxy());
  let failure = "";

  for (let round = 0; round < 2; round++) {
    let pid: number;
    try {
      pid = spawnProxyFn({ cliPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        describeRollback(unwireProxyFn({ log }), `proxy failed to start (${message})`),
      );
    }
    log(`    · proxy process spawned (pid ${pid})`);

    let probe: ProbeResult | null = null;
    for (let attempt = 0; attempt < probeAttempts && !(probe?.alive ?? false); attempt++) {
      await sleepFn(probeIntervalMs);
      probe = await probeProxyFn();
    }
    if (!probe?.alive) {
      // Nothing is listening at all: respawning would hit the same wall,
      // so this is terminal rather than another round.
      failure =
        "proxy did not answer after starting (a busy port or a crash on boot are the usual causes)";
      break;
    }

    const actual = probe.health?.config_fingerprint;
    if (opts.expectedFingerprint === undefined || actual === opts.expectedFingerprint) {
      log("    · proxy is answering");
      return;
    }

    // Something IS serving the proxy port, but not with the credentials
    // this init just wrote — a proxy left over from a previous init,
    // still holding a key that may since have been rotated or revoked.
    // Reporting success here is the worst available outcome: the user
    // is told the proxy is on while every recall and capture silently
    // fails authentication.
    failure =
      "the proxy already on port 8787 is running a different configuration " +
      "(a stale process from an earlier `klio init`)";
    if (round > 0) break;

    log("    ! an older proxy is holding the port with stale credentials — stopping it");
    const stopped = await stopProxyFn();
    log(`    · ${stopped.detail}`);
    if (!stopped.stopped) break;
  }

  throw new Error(describeRollback(unwireProxyFn({ log }), failure));
}

/**
 * Compose a rollback outcome into a thrown message. `unwireProxy`
 * (wiring.ts) is per-agent-isolated and can itself fail for one agent
 * while succeeding for another — a double failure. Silently claiming a
 * clean rollback in that case would be dishonest exactly where honesty
 * about what is still applied matters most, so we name what's still
 * pointed at the proxy instead.
 */
function describeRollback(undone: WireProxyResult, reason: string): string {
  if (undone.errors.length === 0) {
    return `${reason} — rolled back, nothing was left pointed at the proxy`;
  }
  const detail = undone.errors.map((e) => `${e.agent}: ${e.message}`).join("; ");
  return (
    `${reason} — rollback ALSO failed (${detail}). ` +
    `${undone.errors.map((e) => e.agent).join(", ")} may still be pointed at the proxy — ` +
    "run `klio uninit` to finish removing it."
  );
}

/**
 * Prompt for the API key and verify it, looping on recoverable
 * failures. Returns the verified key, or `null` when the flow should
 * abort (missing scope, attempt cap reached, or repeated network
 * failure the user declined to retry).
 *
 * Branches per the /verify contract:
 *   - valid         → return the key (optionally noting org_id).
 *   - missing_scope → explain + abort (a new key with the `memory`
 *                     scope is needed; re-prompting the same key is
 *                     pointless, but the user can supply a different
 *                     one, so we re-prompt within the attempt cap).
 *   - invalid       → "key invalid", re-prompt.
 *   - network_error → surface the error, ask retry/abort.
 */
async function promptAndVerifyKey(
  promptFn: (opts: {
    message: string;
    default?: string;
    mask?: boolean;
  }) => Promise<string>,
  fetchFn: typeof fetch | undefined,
  log: (line: string) => void,
): Promise<string | null> {
  const verify = (k: string) => verifyCloudKey(k, fetchFn ?? globalThis.fetch);

  for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++) {
    const raw = await promptFn({ message: "API key", mask: true });
    const key = raw.trim();
    if (!key) {
      log("  ! API key can't be empty.");
      continue;
    }

    const result = await verify(key);
    switch (result.kind) {
      case "valid":
        log(
          `  ✓ Key verified (${maskKey(key)})` +
            (result.orgId ? ` — org ${result.orgId}` : ""),
        );
        return key;
      case "missing_scope":
        log(
          `  ! That key is valid but lacks the \`memory\` scope (${maskKey(key)}) —`,
        );
        log(
          "    it can't access the Klio brain. Mint a key with the `memory`",
        );
        log("    scope from your dashboard, then paste it here.");
        continue;
      case "invalid":
        log(`  ! Key invalid (${maskKey(key)}) — check it and try again.`);
        continue;
      case "network_error": {
        log(`  ! Couldn't reach the Klio brain: ${result.message}`);
        const retry = await promptFn({
          message: "Retry? [Y/n]",
          default: "Y",
        });
        const ans = retry.trim().toLowerCase();
        if (ans === "n" || ans === "no") {
          log("  — Aborted. Re-run `klio init` once you're back online.");
          return null;
        }
        // Any other answer (including the default) retries — but the
        // retry re-prompts for the key too, since the prior paste may
        // be the problem. We `continue` WITHOUT consuming a fresh
        // attempt for a transient network blip would be ideal, but the
        // attempt cap is the only guard against an infinite loop on a
        // permanently-offline machine, so we let the loop advance.
        continue;
      }
    }
  }

  log(
    "  — Couldn't verify a key after several attempts. Re-run `klio init`",
  );
  log("    with a valid Klio Cloud API key (with the `memory` scope).");
  return null;
}

/**
 * Final reference block printed after wiring. Lists the connected
 * agents, the cloud URL, and a one-liner that memory now persists to
 * Klio Cloud. No dashboard URL — cloud has none yet. The key is shown
 * masked only (last 4) so it never lands in scrollback in full.
 */
function printReferenceBlock(
  log: (line: string) => void,
  configured: string[],
  key: string,
): void {
  log("");
  log("Klio Cloud is ready.");
  log("");
  if (configured.length > 0) {
    log(`  Connected agents:  ${configured.join(", ")}`);
  }
  log(`  Memory endpoint:   ${CLOUD_MCP_URL}`);
  log(`  Authenticated as:  key ${maskKey(key)}`);
  log("");
  log("  Your agents now read and write memory to Klio Cloud — it");
  log("  persists across sessions, machines, and restarts.");
  log("");
}

function writeLine(line: string): void {
  process.stdout.write(line + "\n");
}
