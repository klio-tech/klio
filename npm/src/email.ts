/**
 * Shared email helpers used by `klio configure email` and the
 * Phase 6 email-claim sub-step in `klio init`.
 *
 * Two seams live here:
 *
 *   1. `looksLikeEmail` — permissive client-side shape check. Catches
 *      obvious typos so the user gets a fast local error rather than
 *      a 422 round-trip against the engine. The engine's
 *      pydantic[email] validator runs server-side and is the source
 *      of truth for what's actually accepted.
 *
 *   2. `sendLoginLink` — POSTs to the engine's
 *      `/v1/auth/login-link`. The engine generates the magic link
 *      and (in production) emails it; once the user clicks, the
 *      engine flips `users.claimed_at = now()`. Returns a tagged
 *      result so callers can branch on success/HTTP-failure without
 *      re-implementing the fetch handshake.
 *
 * Both helpers are pure-orchestration: zero I/O outside the supplied
 * `fetchFn`, no module-level mutable state, no process.exit calls.
 * That keeps them safe to import from both interactive (init) and
 * non-interactive (configure) paths.
 *
 * The `runEmailClaim` orchestrator below is the third seam: it bundles
 * the prompt → validate → POST flow used by the init Phase 6 sub-step.
 * Kept in this module (rather than init.ts) so the unit suite can drive
 * it without touching docker / readline / process-level state.
 */


/**
 * Permissive email shape check — catches obvious typos so the user
 * gets a fast local error rather than a 422 round-trip. The engine's
 * pydantic[email] validator runs server-side and is the source of
 * truth for what's actually accepted.
 */
export function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}


/**
 * Result of `sendLoginLink`. Tagged so callers can branch on
 * success/failure without reaching into the underlying Response.
 *
 * On HTTP failure the helper still resolves (rather than throwing)
 * so init's Phase 6 sub-step can degrade cleanly — email is optional;
 * a transient 5xx mustn't abort onboarding.
 */
export type SendLoginLinkResult =
  | { ok: true }
  | { ok: false; status: number; text: string };


/**
 * POST `{ email }` to `<engineURL>/v1/auth/login-link`. The engine
 * looks up the user by `email_hash`, issues a magic-link, and (in
 * production) emails it. The endpoint is unauthenticated by design
 * — it always returns `ok: true` regardless of whether the email
 * exists, so the engine's response doesn't leak account presence.
 *
 * Trailing slashes on `engineURL` are stripped so callers can pass
 * either `http://host:8000` or `http://host:8000/`.
 */
export async function sendLoginLink(
  email: string,
  engineURL: string,
  fetchFn: typeof fetch = fetch,
): Promise<SendLoginLinkResult> {
  const url = engineURL.replace(/\/+$/, "") + "/v1/auth/login-link";
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (res.ok) return { ok: true };
  const text = await res.text().catch(() => "");
  return { ok: false, status: res.status, text };
}


/**
 * Dependencies for `runEmailClaim`. All I/O routes through these
 * fields so the unit suite can drive the helper hermetically.
 *
 * Production callers (init.ts Phase 6) supply the real `prompt`,
 * `fetch`, and a stdout-backed `log`.
 */
export type EmailClaimDeps = {
  /** Base engine URL — e.g. `http://127.0.0.1:8000`. No trailing slash required. */
  engineURL: string;
  /**
   * Prompts the user for an email address. Receives the rendered
   * question and a default placeholder; resolves with the raw
   * answer (empty string when the user just hit Enter).
   */
  promptFn: (opts: { message: string; default?: string }) => Promise<string>;
  /** Single-line writer for user-visible status output. */
  log: (line: string) => void;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
};


/**
 * Maximum number of garbage-input retries before falling through to
 * "skip". Three is generous for an honest typo and tight enough to
 * unblock a non-interactive stdin without spinning forever.
 *
 * Mirrors the spirit of `MAX_UNRECOGNIZED_RETRIES` in confirm.ts —
 * different value because email validation surfaces hint-then-retry
 * once per attempt rather than per-character, so the cap can be
 * smaller without feeling abrupt.
 */
const MAX_GARBAGE_RETRIES = 3;


/**
 * Result of the Phase 6 email-claim sub-step. Tagged so the caller
 * (init.ts) can record telemetry / surface diagnostics if it ever
 * wants to — none of which is wired today.
 */
export type EmailClaimResult =
  | { kind: "skipped" }
  | { kind: "sent"; email: string }
  | { kind: "send_failed"; email: string; status: number };


/**
 * The Phase 6 email-claim sub-prompt orchestrator.
 *
 * Visible flow:
 *   1. Render the "Stay in the loop?" header + body via `log`.
 *   2. Prompt for an email; default is the literal token "skip".
 *   3. Empty input or the "skip" sentinel → return `skipped`, init
 *      continues cleanly.
 *   4. Valid email → POST to `/v1/auth/login-link`; on 2xx return
 *      `sent`, on non-2xx surface a diagnostic and return
 *      `send_failed` (init keeps going — email is optional).
 *   5. Garbage input → emit a hint and re-prompt; cap at three
 *      attempts before treating the run as `skipped`.
 *
 * Never throws on any user-input branch; the only throw paths are
 * unrecoverable I/O issues from the supplied `fetchFn`. Callers
 * should not try/catch — let those propagate so a real engine
 * connectivity bug surfaces instead of being silently swallowed.
 */
export async function runEmailClaim(
  deps: EmailClaimDeps,
): Promise<EmailClaimResult> {
  printPrompt(deps.log);

  for (let attempt = 0; attempt < MAX_GARBAGE_RETRIES; attempt++) {
    const raw = await deps.promptFn({ message: "Email", default: "skip" });
    const trimmed = raw.trim();

    // The default placeholder ("skip") AND an explicit empty/skip
    // input both route to the no-op path. We accept both spellings
    // because the prompt module substitutes the default on empty
    // input — but a curious user who types `skip` literally should
    // get the same outcome.
    if (trimmed === "" || trimmed.toLowerCase() === "skip") {
      deps.log(
        "  ✓ Skipped — you can claim later via `klio configure email <addr>`.",
      );
      return { kind: "skipped" };
    }

    if (!looksLikeEmail(trimmed)) {
      deps.log("  ! Please enter an email or [skip].");
      continue;
    }

    const fetchImpl = deps.fetchFn ?? fetch;
    const res = await sendLoginLink(trimmed, deps.engineURL, fetchImpl);
    if (res.ok) {
      deps.log(
        `  ✓ Magic link sent to ${trimmed}. Click it to verify (optional).`,
      );
      return { kind: "sent", email: trimmed };
    }
    deps.log(
      `  ! Engine couldn't send the magic link (${res.status}) — ` +
        "try `klio configure email <addr>` later.",
    );
    return { kind: "send_failed", email: trimmed, status: res.status };
  }

  // Cap reached — the user typed garbage three times. Treat it as a
  // skip so the rest of init can proceed cleanly. The hint above has
  // already fired three times by now, so the user has been told
  // exactly how to opt in later.
  deps.log(
    "  ✓ Skipped — you can claim later via `klio configure email <addr>`.",
  );
  return { kind: "skipped" };
}


/**
 * Static header / body block above the email prompt. Carved out so
 * `runEmailClaim` reads top-down without a wall of `log` calls
 * obscuring the control flow.
 */
function printPrompt(log: (line: string) => void): void {
  log("");
  log("──────────");
  log("  Stay in the loop?");
  log("");
  log("  Klio is in active development — there have been four releases");
  log("  today. Drop your email and we'll send security and breaking-change");
  log("  notifications. We won't spam you.");
  log("");
}
