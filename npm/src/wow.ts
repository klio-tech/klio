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
   * Auth token sent as `Authorization: Bearer <token>` on both POSTs.
   * Today the engine accepts the refresh token here; if/when that
   * changes the caller swaps in an access token and this module is
   * unchanged.
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
const ENTRY_KIND = "preference";

export async function runWowMoment(deps: WowDeps): Promise<WowResult> {
  const fetchFn = deps.fetchFn ?? fetch;

  const memory = await deps.promptFn({
    message: "Your memory",
    multiline: true,
  });

  const entryID = await writeMemory(fetchFn, deps, memory);
  deps.log(`      ✓ stored as fact (id: ${truncateID(entryID)})`);

  const recallScore = await verifyRecall(fetchFn, deps, entryID);

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

async function writeMemory(
  fetchFn: typeof fetch,
  deps: WowDeps,
  memory: string,
): Promise<string> {
  const res = await fetchFn(`${deps.engineURL}/v1/entries`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${deps.refreshToken}`,
    },
    body: JSON.stringify({
      space_id: deps.spaceID,
      kind: ENTRY_KIND,
      content: memory,
      metadata: { source: MEMORY_SOURCE },
      confidence: 1.0,
    }),
  });
  if (!res.ok) {
    throw new Error(`store memory failed (HTTP ${res.status})`);
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
  entryID: string,
): Promise<number> {
  const res = await fetchFn(
    `${deps.engineURL}/v1/spaces/${deps.spaceID}/recall`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deps.refreshToken}`,
      },
      body: JSON.stringify({ query: RECALL_QUERY, limit: 1 }),
    },
  );
  if (!res.ok) {
    deps.log(`      ! recall failed (HTTP ${res.status}) — proceeding anyway`);
    return 0;
  }
  const body = (await res.json()) as {
    results?: { id: string; score: number }[];
  };
  const top = body.results?.[0];
  if (!top || top.id !== entryID) {
    deps.log("      ! recall returned a different top entry — proceeding anyway");
    return 0;
  }
  deps.log(`      ✓ found, score ${top.score.toFixed(2)}`);
  return top.score;
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
