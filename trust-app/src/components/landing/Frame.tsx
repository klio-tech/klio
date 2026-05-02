import type { ReactNode } from "react";

/**
 * IDE / terminal-style chrome card. Used as the visual focal point
 * across the landing — hero, anatomy lenses, quick start, etc. The
 * "dark" variant looks like a modern terminal/editor; the "paper"
 * variant blends into the editorial background for the lens cards.
 */
export function Frame({
  children,
  variant = "dark",
  path,
  badge,
  footL,
  footR,
  showDots = true,
  bodyStyle,
  style,
}: {
  children: ReactNode;
  variant?: "dark" | "paper";
  /** Filename / endpoint shown centered in the bar */
  path?: string;
  /** Right-aligned tag (e.g. "MCP", "RECALL", "768d") */
  badge?: string;
  /** Footer status row, left side (e.g. "200 OK · 1.4 ms") */
  footL?: ReactNode;
  /** Footer status row, right side (e.g. "3 entries · nomic-768") */
  footR?: ReactNode;
  showDots?: boolean;
  bodyStyle?: React.CSSProperties;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`k-frame ${variant === "paper" ? "k-frame--paper" : ""}`.trim()}
      style={style}
    >
      {(showDots || path || badge) && (
        <div className="k-frame__bar">
          {showDots && (
            <span className="k-frame__dots" aria-hidden>
              <span className="k-frame__dot" />
              <span className="k-frame__dot" />
              <span className="k-frame__dot k-frame__dot--accent" />
            </span>
          )}
          {path && <span className="k-frame__path">{path}</span>}
          {badge && <span className="k-frame__badge">{badge}</span>}
        </div>
      )}

      <div className="k-frame__body" style={bodyStyle}>
        {children}
      </div>

      {(footL || footR) && (
        <div className="k-frame__foot">
          <span>{footL}</span>
          <span>{footR}</span>
        </div>
      )}
    </div>
  );
}
