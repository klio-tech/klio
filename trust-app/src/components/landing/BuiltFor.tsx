/**
 * "Built for developers" pairs — six adjective/value pairs in a tight
 * monospace pseudo-CSV. Echoes the supadata layout but without icons.
 */

const PAIRS: { left: string; right: string }[] = [
  { left: "Fast",       right: "1-5 ms recall p50, native Metal embeds on macOS" },
  { left: "Local",      right: "Postgres + pgvector + Redis + Ollama, all in Docker" },
  { left: "Yours",      right: "Encrypted under a key only you hold; no cloud handshake" },
  { left: "Open",       right: "Apache 2.0 shim, AGPL v3 engine — auditable end-to-end" },
  { left: "Pluggable",  right: "Swap embedding models per space, no schema rebuild" },
  { left: "Real-time",  right: "Redis pub/sub fans out frames in milliseconds" },
];

export function BuiltFor() {
  return (
    <section className="k-section">
      <div className="k-container">
        <header style={{ marginBottom: "3rem", maxWidth: "60ch" }}>
          <p className="k-eyebrow">built for developers, by developers</p>
          <h2 className="k-h2" style={{ marginTop: "1rem" }}>
            Nobody likes bloated APIs.
          </h2>
          <p className="k-lede" style={{ marginTop: "1.2rem" }}>
            Klio is the memory layer your AI stack should already have had.
            Local-first, MCP-native, no SDK to install per agent, no
            connector marketplace to buy into.
          </p>
        </header>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
            gap: "0",
            border: "1px solid var(--klio-border)",
            borderBottom: 0,
          }}
        >
          {PAIRS.map((p) => (
            <div
              key={p.left}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(120px, 0.4fr) 1fr",
                gap: "1.5rem",
                padding: "1.2rem 1.6rem",
                borderRight: "1px solid var(--klio-border)",
                borderBottom: "1px solid var(--klio-border)",
                alignItems: "baseline",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-serif-stack)",
                  fontSize: "1.5rem",
                  letterSpacing: "-0.018em",
                  color: "var(--klio-foreground)",
                }}
              >
                {p.left}
              </div>
              <div
                style={{
                  fontFamily: "var(--font-sans-stack)",
                  fontSize: "0.95rem",
                  lineHeight: 1.5,
                  color: "var(--klio-muted)",
                }}
              >
                {p.right}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
