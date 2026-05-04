// The "wow moment" — the showstopper UX after onboarding succeeds.
//
// We force the user to type one memory in their own words, write it
// to the engine, then immediately recall it back to prove the loop
// closes. The whole point is to make persistence concrete and
// verifiable in <30 seconds. If we can't recall what we just wrote,
// the install is broken and the user should know now, not later.
//
// All I/O is dependency-injected so the test suite can run hermetic
// (no real network, no real readline) and the production caller
// (init.ts) can wire stdout, fetch, and the press-enter blocker
// without this module knowing about any of them.

export type WowDeps = {
  /** Base URL of the engine, e.g. "http://localhost:8000". No trailing slash. */
  engineURL: string;
  /**
   * Refresh token returned by /v1/users/provision. We exchange it for
   * a short-lived access token via /v1/tokens/refresh on entry to
   * runWowMoment — `require_auth` on /v1/spaces/{id}/entries decodes
   * a JWT, not a raw refresh token, so the exchange must happen here.
   */
  refreshToken: string;
  /** Target space ID for the write + the recall. */
  spaceID: string;
  /**
   * Prompts the user for the memory body. Always called with
   * `multiline: true` — the message is the only knob a future caller
   * might want to override (kept on the dep so this module can be
   * reused for variants without retesting the network logic).
   */
  promptFn: (opts: { message: string; multiline?: boolean }) => Promise<string>;
  /** Single-line writer for user-visible status output. */
  log: (line: string) => void;
  /**
   * Blocks until the user presses enter (or the caller decides to
   * unblock). Caller is responsible for the actual readline machinery
   * — this module only awaits the gate.
   */
  waitEnter: () => Promise<void>;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
};

export type WowResult = {
  entryID: string;
  /**
   * Top recall match's score when the recalled top result's id matches
   * the just-written entry. `0` when recall returned a different top
   * entry (we still proceed; the warning was logged).
   */
  recallScore: number;
};

const RECALL_QUERY = "what should you remember about me";
const MEMORY_SOURCE = "klio init wow moment";
// Engine-side `VALID_KINDS_V0` in
// engine/src/klio_engine/schemas/entries.py defines the accepted set
// — `memory` is the right tag for a user-entered persistent fact.
// `preference` was a pre-0.3.0 typo that 404'd (or 422'd) at write
// time because it isn't in VALID_KINDS_V0.
const ENTRY_KIND = "memory";

export async function runWowMoment(deps: WowDeps): Promise<WowResult> {
  const fetchFn = deps.fetchFn ?? fetch;

  // Exchange the long-lived refresh token for a short-lived access
  // token before the entries write — `require_auth` on the engine
  // decodes a JWT, and refresh tokens are opaque url-safe strings.
  const accessToken = await exchangeRefreshForAccess(
    fetchFn,
    deps.engineURL,
    deps.refreshToken,
  );

  const memory = await deps.promptFn({
    message: "Your memory",
    multiline: true,
  });

  const entryID = await writeMemory(fetchFn, deps, accessToken, memory);
  deps.log(`      ✓ stored as fact (id: ${truncateID(entryID)})`);

  const recallScore = await verifyRecall(fetchFn, deps, accessToken, entryID);

  printPostWriteInstructions(deps);
  await deps.waitEnter();
  deps.log("");
  deps.log("    ✓ Confirmed.");
  deps.log("");
  deps.log(
    "    Try it again from a brand-new Claude Code session to see persistence.",
  );

  return { entryID, recallScore };
}

/**
 * POST /v1/tokens/refresh — exchange the refresh token returned by
 * /v1/users/provision for a JWT access token. The engine's auth
 * decorator on /v1/spaces/{id}/entries (and /recall) requires the
 * latter; sending the refresh token directly fails with a JWT
 * decode error rendered as 401.
 */
async function exchangeRefreshForAccess(
  fetchFn: typeof fetch,
  engineURL: string,
  refreshToken: string,
): Promise<string> {
  const res = await fetchFn(`${engineURL}/v1/tokens/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    throw new Error(
      `token exchange failed (HTTP ${res.status}) — refresh token rejected by engine`,
    );
  }
  const body = (await res.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new Error("token exchange failed (engine did not return an access_token)");
  }
  return body.access_token;
}

async function writeMemory(
  fetchFn: typeof fetch,
  deps: WowDeps,
  accessToken: string,
  memory: string,
): Promise<string> {
  // Route is /v1/spaces/{space_id}/entries — space_id lives in the
  // URL path so we omit it from the body. EntryWrite schema
  // accepts: kind (in VALID_KINDS_V0), content, metadata?, confidence?.
  const res = await fetchFn(
    `${deps.engineURL}/v1/spaces/${deps.spaceID}/entries`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        kind: ENTRY_KIND,
        content: memory,
        metadata: { source: MEMORY_SOURCE },
        confidence: 1.0,
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `store memory failed (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }
  const body = (await res.json()) as { id?: unknown };
  if (typeof body.id !== "string" || body.id.length === 0) {
    throw new Error("store memory failed (engine did not return an id)");
  }
  return body.id;
}

/**
 * Run the recall and report. Returns the score when the top match
 * is the entry we just wrote; returns 0 (and logs a warning) when
 * the top match is a different entry. We deliberately don't throw
 * on a mismatch — the user should still continue the flow; they'll
 * see the warning and can retry from Claude Code.
 */
async function verifyRecall(
  fetchFn: typeof fetch,
  deps: WowDeps,
  accessToken: string,
  entryID: string,
): Promise<number> {
  const res = await fetchFn(
    `${deps.engineURL}/v1/spaces/${deps.spaceID}/recall`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ query: RECALL_QUERY, limit: 1 }),
    },
  );
  if (!res.ok) {
    deps.log(`      ! recall failed (HTTP ${res.status}) — proceeding anyway`);
    return 0;
  }
  // Engine's POST /v1/spaces/{id}/recall returns a flat list of
  // EntryResponse — `id`, `content`, `kind`, etc. The cosine score
  // is computed server-side but NOT surfaced in the response, so
  // we report 1.0 on a positive id match and 0 on miss.
  const body = (await res.json()) as { id?: string }[] | unknown;
  const list = Array.isArray(body) ? body : [];
  const top = list[0];
  if (!top || top.id !== entryID) {
    deps.log("      ! recall returned a different top entry — proceeding anyway");
    return 0;
  }
  deps.log("      ✓ found in top result");
  return 1.0;
}

function truncateID(id: string): string {
  if (id.length <= 8) return id;
  return `${id.slice(0, 8)}…`;
}

function printPostWriteInstructions(deps: WowDeps): void {
  deps.log("");
  deps.log("───────────────────────────────────────────────────────");
  deps.log("🪄 Now open Claude Code in any project and ask:");
  deps.log("");
  deps.log('       "What do you know about me?"');
  deps.log("");
  deps.log(
    "    Claude will use the klio recall tool and tell you back exactly",
  );
  deps.log("    what you just typed.");
  deps.log("");
  deps.log("    [press enter when you've seen it work, or ctrl-c if it didn't]");
}
