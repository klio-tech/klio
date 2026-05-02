/**
 * "Works with" bar — typographic only (no scraped logos), supadata-style.
 *
 * Each entry is a short wordmark in monospace, separated by a dot
 * spacer. We deliberately do NOT use real third-party logos because
 * (a) we don't have trademark licenses for them and (b) the
 * typographic treatment ages better than a logo grid that goes stale
 * the moment a vendor rebrands.
 */
const WORKS_WITH = [
  "claude code",
  "cursor",
  "codex",
  "ollama",
  "openai",
  "anthropic",
  "litellm",
  "postgres",
  "pgvector",
  "redis",
];

export function TrustBar() {
  return (
    <section
      style={{
        paddingBlock: "2.5rem",
        borderTop: "1px solid var(--klio-border)",
        borderBottom: "1px solid var(--klio-border)",
        background: "var(--klio-paper)",
      }}
    >
      <div
        className="k-container"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "2.4rem",
          flexWrap: "wrap",
          justifyContent: "space-between",
        }}
      >
        <span
          className="k-eyebrow"
          style={{ flexShrink: 0 }}
        >
          works with
        </span>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "1rem",
            rowGap: "0.6rem",
            flexWrap: "wrap",
            fontFamily: "var(--font-mono-stack)",
            fontSize: "0.85rem",
            color: "var(--klio-muted)",
          }}
        >
          {WORKS_WITH.map((name, i) => (
            <span key={name} style={{ display: "inline-flex", alignItems: "center", gap: "1rem" }}>
              <span>{name}</span>
              {i < WORKS_WITH.length - 1 && (
                <span aria-hidden style={{ color: "var(--klio-faint)" }}>·</span>
              )}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
