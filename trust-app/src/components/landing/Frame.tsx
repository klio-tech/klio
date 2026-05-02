import type { ReactNode } from "react";

/**
 * A calm card with a thin chrome bar. Used as the visual focal point
 * across the landing — hero JSON sample, anatomy lenses, quick-start
 * session, etc. Paper-only by design — the page's whole aesthetic is
 * "premium minimal editorial on warm white", and dark IDE chrome was
 * fighting it.
 *
 * The bar is optional. When present it carries: a small endpoint or
 * filename label on the left, an optional badge on the right. No
 * traffic-light dots — they're hokey on a magazine-grade landing.
 */
export function Frame({
  children,
  path,
  badge,
  footL,
  footR,
  bodyStyle,
  style,
}: {
  children: ReactNode;
  /** Filename / endpoint shown on the left of the bar */
  path?: string;
  /** Right-aligned tag (e.g. "MCP", "768d", "AES-256-GCM") */
  badge?: string;
  /** Footer status row, left side */
  footL?: ReactNode;
  /** Footer status row, right side */
  footR?: ReactNode;
  bodyStyle?: React.CSSProperties;
  style?: React.CSSProperties;
}) {
  return (
    <div className="k-frame" style={style}>
      {(path || badge) && (
        <div className="k-frame__bar">
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
