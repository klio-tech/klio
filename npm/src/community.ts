// Community asks — the brief, defaults-Y nudge to star the repo and
// join the Discord. Runs at the very end of `klio init`, after the
// wow moment has demonstrated value, when the user is most likely
// to say yes.
//
// Both URL opens are fire-and-forget: we hand the URL to the injected
// `openUrlFn` and assume it returns immediately. The default
// implementation in `openUrl.ts` shells out to `open` / `xdg-open` /
// `start` and ignores the child process — we deliberately don't block
// on the browser actually opening, since that's a poor signal of
// success and would stall the install on systems without a default
// browser configured.
//
// Defaults are "Y" so an empty answer (just hitting Enter) accepts.
// The yes-detector is generous on whitespace and case to forgive
// inputs like "  y  " or "Yes\n".

const REPO_URL = "https://github.com/klio-tech/klio";
const DISCORD_URL = "https://discord.gg/xRRPnW3fN2";

export type CommunityDeps = {
  /**
   * Prompts the user with a yes/no question. Caller's prompt impl is
   * expected to honour `default` so an empty answer maps back to "Y".
   */
  promptFn: (opts: { message: string; default?: string }) => Promise<string>;
  /**
   * Open the URL in the user's default browser. Fire-and-forget —
   * never throws, never awaits.
   */
  openUrlFn: (url: string) => void;
  /** User-visible status line writer. */
  log: (line: string) => void;
};

/**
 * Treats empty / "y" / "yes" (any case, with trailing whitespace) as
 * acceptance. Anything else is treated as a decline. We err on the
 * side of accepting because the prompt itself defaults to "Y" — a
 * user who really wants to skip will type something explicit.
 */
function isYes(answer: string): boolean {
  const t = answer.trim().toLowerCase();
  return t === "" || t === "y" || t === "yes";
}

function hostPath(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

export async function runCommunityAsks(deps: CommunityDeps): Promise<void> {
  deps.log("");
  deps.log(
    "Klio is open-source and community-built. If this saved you even",
  );
  deps.log("an ounce of friction:");
  deps.log("");

  const star = await deps.promptFn({
    message: "Star us on GitHub?",
    default: "Y",
  });
  if (isYes(star)) {
    deps.openUrlFn(REPO_URL);
    deps.log(`      ✓ opened ${hostPath(REPO_URL)} in your browser`);
  }

  const discord = await deps.promptFn({
    message: "Join the Discord?",
    default: "Y",
  });
  if (isYes(discord)) {
    deps.openUrlFn(DISCORD_URL);
    deps.log(`      ✓ opened ${hostPath(DISCORD_URL)} in your browser`);
  }
}
