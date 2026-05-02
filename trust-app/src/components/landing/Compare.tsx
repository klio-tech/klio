/**
 * "Klio vs the rest" — feature × product matrix. Editorial table style:
 * hairline rows, mono numbers/marks, no zebra-striping.
 */

type Cell = "yes" | "partial" | "no" | string;

const COLUMNS = ["Klio", "mem0", "Zep", "Supermemory"] as const;

const ROWS: { feature: string; cells: Cell[] }[] = [
  { feature: "Open source",                          cells: ["AGPL+Apache split", "Apache", "Apache", "no"] },
  { feature: "Self-hosted by default",               cells: ["yes", "yes", "yes", "no"] },
  { feature: "Encrypted at rest, user-owned key",    cells: ["yes", "no",  "no",  "no"] },
  { feature: "Cryptographic audit chain",            cells: ["yes", "no",  "no",  "no"] },
  { feature: "MCP-native (drops into agents)",       cells: ["yes", "SDK", "SDK", "SDK"] },
  { feature: "Real-time cross-agent pub/sub",        cells: ["yes", "no",  "partial", "no"] },
  { feature: "Per-space pluggable embeddings",       cells: ["5 models, runtime-switch", "global", "global", "opaque"] },
  { feature: "Anonymous-first onboarding",           cells: ["yes", "account", "account", "account"] },
];

function renderCell(c: Cell, isUs: boolean) {
  const baseStyle: React.CSSProperties = {
    fontFamily: c === "yes" || c === "no" || c === "partial" || c === "SDK" || c === "global" || c === "account" || c === "opaque"
      ? "var(--font-mono-stack)"
      : "var(--font-sans-stack)",
    fontSize: c === "yes" || c === "no" || c === "partial" ? "0.92rem" : "0.86rem",
    color: isUs ? "var(--klio-foreground)" : "var(--klio-muted)",
    fontWeight: isUs ? 500 : 400,
  };

  if (c === "yes") {
    return <span style={{ ...baseStyle, color: isUs ? "var(--klio-accent)" : "var(--klio-foreground)" }}>● yes</span>;
  }
  if (c === "no") {
    return <span style={{ ...baseStyle, color: "var(--klio-faint)" }}>○ no</span>;
  }
  if (c === "partial") {
    return <span style={baseStyle}>◐ partial</span>;
  }
  return <span style={baseStyle}>{c}</span>;
}

export function Compare() {
  return (
    <section
      className="k-section"
      style={{ background: "var(--klio-paper)" }}
    >
      <div className="k-container">
        <header style={{ marginBottom: "3rem", maxWidth: "60ch" }}>
          <p className="k-eyebrow">how klio compares</p>
          <h2 className="k-h2" style={{ marginTop: "1rem" }}>
            Trust + protocol over connectors + polish.
          </h2>
          <p className="k-lede" style={{ marginTop: "1.2rem" }}>
            mem0 and Zep are both excellent if you want a hosted memory SDK.
            Supermemory is excellent if you want frictionless cloud onboarding.
            Klio takes a different bet — own your data, embed in any MCP agent,
            verify the chain.
          </p>
        </header>

        <div
          style={{
            background: "var(--klio-background)",
            border: "1px solid var(--klio-border)",
            borderRadius: "0.5rem",
            overflow: "hidden",
          }}
        >
          <div
            role="table"
            aria-label="Klio vs alternatives"
            className="compare-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(180px, 1.6fr) repeat(4, minmax(0, 1fr))",
              fontFamily: "var(--font-sans-stack)",
            }}
          >
            <div role="row" style={{ display: "contents" }}>
              <div role="columnheader" style={headerCell}>Feature</div>
              {COLUMNS.map((col, i) => (
                <div
                  key={col}
                  role="columnheader"
                  style={{
                    ...headerCell,
                    color: i === 0 ? "var(--klio-accent)" : "var(--klio-muted)",
                    fontWeight: i === 0 ? 600 : 500,
                  }}
                >
                  {col}
                </div>
              ))}
            </div>

            {ROWS.map((r, ri) => (
              <div role="row" key={r.feature} style={{ display: "contents" }}>
                <div
                  role="rowheader"
                  style={{
                    ...rowCell(ri, ROWS.length),
                    fontFamily: "var(--font-sans-stack)",
                    color: "var(--klio-foreground)",
                    fontWeight: 500,
                  }}
                >
                  {r.feature}
                </div>
                {r.cells.map((c, ci) => (
                  <div
                    key={ci}
                    role="cell"
                    data-col={COLUMNS[ci]}
                    style={rowCell(ri, ROWS.length)}
                  >
                    {renderCell(c, ci === 0)}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

const headerCell: React.CSSProperties = {
  padding: "1rem 1.2rem",
  borderBottom: "1px solid var(--klio-border)",
  fontFamily: "var(--font-mono-stack)",
  fontSize: "0.72rem",
  letterSpacing: "0.12em",
  textTransform: "uppercase",
};

function rowCell(rowIndex: number, totalRows: number): React.CSSProperties {
  return {
    padding: "0.95rem 1.2rem",
    borderBottom:
      rowIndex < totalRows - 1
        ? "1px solid var(--klio-border)"
        : "0",
    fontSize: "0.95rem",
    color: "var(--klio-muted)",
  };
}
