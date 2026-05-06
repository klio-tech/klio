/**
 * Curator config — env-line shape for ~/.klio/.env.
 *
 * The CLI's two surfaces (`klio init` Phase 6 and `klio update
 * curator`) collect a `{enabled, cadence, model}` triple from the
 * user. This module is the single seam that turns that triple into
 * the env block the engine container reads at startup.
 *
 * Pure: no fs, no spawn, no global state. Trivially testable.
 *
 * The cadence labels are part of the public CLI surface — a future
 * `klio update curator` against a config written by an older CLI
 * must still recognise them. Keep the slugs stable.
 */

/** All five cadence options the picker offers. */
export type CuratorCadence =
  | "hourly"
  | "every-4h"
  | "daily"
  | "on-demand"
  | "disabled";

/** Cadence → human label + interval seconds, for the picker UI. */
export const CURATOR_CADENCE_LABELS: ReadonlyArray<{
  slug: CuratorCadence;
  label: string;
  intervalSecs: number;
}> = [
  { slug: "hourly", label: "every hour", intervalSecs: 3600 },
  { slug: "every-4h", label: "every 4 hours", intervalSecs: 14400 },
  { slug: "daily", label: "once a day", intervalSecs: 86400 },
  // On-demand: no real periodic tick. The user runs
  // `klio update curator --run-now` to drain. We still need an
  // interval value to feed APScheduler — pick one year as a
  // "basically never" sentinel.
  { slug: "on-demand", label: "on-demand only", intervalSecs: 31536000 },
  // Disabled: enabled flag flips false; interval value is ignored
  // by the lifespan but we keep it consistent (1 year) for
  // observability.
  { slug: "disabled", label: "disable", intervalSecs: 31536000 },
] as const;

/** A user-picked curator config. */
export interface CuratorConfig {
  /** The KLIO_CURATOR_ENABLED flag — false ONLY when cadence is "disabled". */
  enabled: boolean;
  /** One of the five cadence options. */
  cadence: CuratorCadence;
  /**
   * Routing-shape model identifier. Empty string means "fall back
   * to the user's extraction model" (the engine's
   * `effective_curator_model` resolves this server-side).
   */
  model: string;
}

/**
 * Resolve the cadence slug to its interval seconds. Throws on
 * unknown slug — keeps the error surface narrow rather than
 * silently defaulting.
 */
function intervalSecsFor(cadence: CuratorCadence): number {
  const entry = CURATOR_CADENCE_LABELS.find((c) => c.slug === cadence);
  if (entry === undefined) {
    throw new Error(`unknown curator cadence: ${cadence}`);
  }
  return entry.intervalSecs;
}

/**
 * Render the curator's env-block as the lines `~/.klio/.env` should
 * carry. The trailing newline is included so the helper can be
 * appended to an existing env file as-is.
 */
export function curatorEnvLines(cfg: CuratorConfig): string {
  const lines = [
    `KLIO_CURATOR_ENABLED=${cfg.enabled ? "true" : "false"}`,
    `KLIO_CURATOR_INTERVAL_SECS=${intervalSecsFor(cfg.cadence)}`,
    `KLIO_CURATOR_MODEL=${cfg.model}`,
  ];
  return lines.join("\n") + "\n";
}
