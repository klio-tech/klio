/**
 * FAQ accordion. Uses native <details>/<summary> so it works without
 * JavaScript (matters for the machine view's URL fallback). The
 * default open state is the first entry — sets reading rhythm without
 * forcing a click before any answer is visible.
 */

const QA: { q: string; a: string }[] = [
  {
    q: "Does my data ever leave my machine?",
    a: "No. The default install runs Postgres, Redis, and your embedding model in Docker on your laptop. The bridge daemon talks to the engine over a Unix socket. Nothing phones home, no telemetry, no analytics. Klio Cloud (when launched) is opt-in — you'd have to actively choose to sync.",
  },
  {
    q: "What's actually stored, and how is it encrypted?",
    a: "Each entry's content + metadata is sealed with AES-256-GCM under a per-user envelope key. That envelope key is itself wrapped under a master key in ~/.klio/dev-kms.key (mode 0600). Production deployments swap the file-backed master for AWS KMS. Plaintext is never written to disk; the engine decrypts in memory only when you read.",
  },
  {
    q: "Can I switch embedding models without re-architecting?",
    a: "Yes. Each space pins its own model (nomic-embed-text 768d by default, or snowflake-arctic-embed2 1024d, OpenAI text-embedding-3-small 1536d, etc). To switch, run `klio reembed --space <id> --to <new-model>`. Per-dim shadow tables mean the storage layer doesn't care.",
  },
  {
    q: "Does this work with Cursor and Codex?",
    a: "The MCP server works with any agent that speaks the Model Context Protocol — Cursor and Codex both do. The auto-init for Cursor and Codex is in the v0.x roadmap; Claude Code is fully wired today. For Cursor right now, you'd register klio-mcp manually in ~/.cursor/mcp.json — about a 30-second copy-paste.",
  },
  {
    q: "Windows support?",
    a: "Not yet a Tier 1 platform. The engine and bridge compile on WSL2; the trust-app + Docker setup work via Docker Desktop. Native Windows is on the roadmap once macOS + Linux are battle-tested in v0.x.",
  },
  {
    q: "What's the license, and can I embed Klio in a closed-source product?",
    a: "Split license. The MCP shim and Claude Code plugin are Apache 2.0 — you can embed them anywhere. The engine, daemon, and trust-app are AGPL v3 — fork freely, but a hosted modified version must release its source. Email contact@klio.tech for a commercial license if you need to embed the AGPL components in a closed product.",
  },
];

export function FAQ() {
  return (
    <section className="k-section">
      <div className="k-container">
        <header style={{ marginBottom: "3rem", maxWidth: "60ch" }}>
          <p className="k-eyebrow">faqs</p>
          <h2 className="k-h2" style={{ marginTop: "1rem" }}>
            Questions, answered honestly.
          </h2>
        </header>

        <div style={{ maxWidth: "780px", borderTop: "1px solid var(--klio-border)" }}>
          {QA.map((item, i) => (
            <details
              key={item.q}
              open={i === 0}
              style={{
                borderBottom: "1px solid var(--klio-border)",
              }}
            >
              <summary
                style={{
                  listStyle: "none",
                  padding: "1.4rem 0",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono-stack)",
                  fontWeight: 600,
                  fontSize: "1.05rem",
                  letterSpacing: "-0.005em",
                  color: "var(--klio-foreground)",
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: "1.5rem",
                }}
              >
                <span>{item.q}</span>
                <span
                  aria-hidden
                  style={{
                    fontFamily: "var(--font-mono-stack)",
                    fontSize: "0.95rem",
                    color: "var(--klio-faint)",
                    flexShrink: 0,
                  }}
                  className="faq-chevron"
                >
                  +
                </span>
              </summary>
              <p
                style={{
                  paddingBlock: "0.2rem 1.6rem",
                  paddingRight: "3rem",
                  color: "var(--klio-muted)",
                  fontSize: "1rem",
                  lineHeight: 1.65,
                  maxWidth: "70ch",
                }}
              >
                {item.a}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
