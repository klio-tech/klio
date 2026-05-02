/**
 * The Klio mark — three stacked horizontal bars with the middle bar
 * indented from the left. Reads as "a memory cell with its active
 * layer set apart" without being literal about it. Geometry only,
 * no letterforms.
 *
 * Stays legible at favicon size (16px) up to display use (40+px).
 * Pure currentColor so it inherits whatever ink the parent sets —
 * works in the header, footer, dashboard nav, and the rare dark
 * surface (e.g. a print export) without per-call colour wiring.
 */
export function KlioMark({
  size = 24,
  title = "Klio",
}: {
  size?: number;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={title}
      style={{ display: "block", flexShrink: 0 }}
    >
      <title>{title}</title>
      {/* Top bar — full width */}
      <rect x="3"  y="6"  width="18" height="2" fill="currentColor" />
      {/* Middle bar — indented from the left */}
      <rect x="8"  y="11" width="13" height="2" fill="currentColor" />
      {/* Bottom bar — full width */}
      <rect x="3"  y="16" width="18" height="2" fill="currentColor" />
    </svg>
  );
}
