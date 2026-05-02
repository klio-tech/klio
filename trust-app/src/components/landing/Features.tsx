/**
 * "What's inside" — six-cell feature grid laid out like a print
 * catalogue. Each cell has a numeric label, a tight title, and a
 * paragraph of body. No icons — typography does the work.
 */

const FEATURES: { num: string; title: string; body: string }[] = [
  {
    num: "01",
    title: "Seven MCP tools",
    body: "recall · remember · observe · plan · decide · note · space. Drop-in for any MCP-aware agent. No SDK to install per agent — the protocol does the integration.",
  },
  {
    num: "02",
    title: "Encrypted at rest",
    body: "Every entry is sealed under an AES-256-GCM envelope key wrapped by a master that lives only in your home directory at 0600. We never see the plaintext. We can't.",
  },
  {
    num: "03",
    title: "Cryptographic audit",
    body: "SHA-256 hash chain over every action, hourly notarized to OpenTimestamps for blockchain-anchored proof of existence. Tamper-evident by construction, not policy.",
  },
  {
    num: "04",
    title: "Real-time pub/sub",
    body: "Each entry write publishes to Redis on space:<id>. Other agents subscribe and receive frames within milliseconds. Cross-agent collaboration without polling.",
  },
  {
    num: "05",
    title: "Pluggable embeddings",
    body: "Per-space pin: nomic-embed-text (768d), snowflake-arctic-embed2 (1024d), text-embedding-3-small (1536d), and more. Switch models live with klio reembed.",
  },
  {
    num: "06",
    title: "Local-first by design",
    body: "Postgres, Redis, and your embedding model all run in Docker on your laptop. Klio Cloud is opt-in. Your memories never leave the machine unless you ship them yourself.",
  },
];

export function Features() {
  return (
    <section className="k-section">
      <div className="k-container">
        <header style={{ marginBottom: "3.5rem", maxWidth: "60ch" }}>
          <p className="k-eyebrow">what's inside</p>
          <h2 className="k-h2" style={{ marginTop: "1rem" }}>
            A memory daemon, not a SaaS.
          </h2>
          <p className="k-lede" style={{ marginTop: "1.2rem" }}>
            Each capability below is shipping today in the open-source release —
            not paywalled, not behind a beta flag, not "coming soon."
          </p>
        </header>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "0",
            border: "1px solid var(--klio-border)",
          }}
        >
          {FEATURES.map((f) => (
            <article
              key={f.num}
              style={{
                padding: "2.2rem 2rem",
                borderRight: "1px solid var(--klio-border)",
                borderBottom: "1px solid var(--klio-border)",
                background: "var(--klio-background)",
                position: "relative",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-mono-stack)",
                  fontSize: "0.72rem",
                  color: "var(--klio-faint)",
                  letterSpacing: "0.08em",
                  marginBottom: "1.5rem",
                }}
              >
                {f.num}
              </div>
              <h3
                className="k-h3"
                style={{
                  fontSize: "1.18rem",
                  marginBottom: "0.7rem",
                  letterSpacing: "-0.012em",
                }}
              >
                {f.title}
              </h3>
              <p
                style={{
                  fontSize: "0.96rem",
                  lineHeight: 1.55,
                  color: "var(--klio-muted)",
                  maxWidth: "44ch",
                }}
              >
                {f.body}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
