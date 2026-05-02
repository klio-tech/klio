/**
 * Two-mode rendering for klio.tech.
 *
 * The same URL serves either a human-readable marketing page or a
 * machine-readable structured page. The mode is decided in this order:
 *
 *   1. Explicit query string (?view=human or ?view=machine) — always wins.
 *   2. User-Agent sniff for bots / agents / known LLM crawlers — these
 *      get the machine view by default so they ingest clean facts
 *      instead of marketing prose.
 *   3. Default: human.
 *
 * Resolution happens server-side in the page component (see
 * src/app/page.tsx) so the response bytes are correct before any JS
 * runs. The ViewToggle client component then lets a JS-enabled human
 * flip the mode at will, persisting the choice via the URL.
 */

export type ViewMode = "human" | "machine";

/**
 * Patterns that match common LLM agents, web crawlers, and headless
 * fetchers. The pattern is intentionally permissive — false positives
 * (a human user accidentally on the machine view) are recoverable
 * with one click on the toggle, while false negatives (an agent
 * scraping the marketing fluff) waste tokens.
 */
const BOT_UA_PATTERN =
  /\b(bot|spider|crawler|crawl|preview|fetch|httpclient|scraper)\b|gpt|claude|cursor|codex|anthropic|openai|chatgpt|perplexity|googlebot|bingbot|duckduckbot|slackbot|discordbot|facebookexternalhit|linkedinbot|twitterbot|whatsapp|telegram|curl|wget|python-requests|node-fetch|got|axios|undici|libwww|java-/i;

export function isBotUserAgent(ua: string | null | undefined): boolean {
  if (!ua) return false;
  return BOT_UA_PATTERN.test(ua);
}

export function detectViewMode(
  searchParam: string | undefined,
  userAgent: string | null | undefined,
): ViewMode {
  if (searchParam === "machine") return "machine";
  if (searchParam === "human") return "human";
  if (isBotUserAgent(userAgent)) return "machine";
  return "human";
}
