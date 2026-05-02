/**
 * The seven MCP tools, each shown as a real call → real response
 * pair. This replaces the previous adjective/value pairs because
 * developers learn faster from a one-line example than from a
 * marketing line.
 */

const TOOLS: { name: string; sig: string; out: string; flavour?: string }[] = [
  {
    name: "recall",
    sig: 'recall({ query: "which JS runtime do I prefer?" })',
    out: "[memory] User prefers Bun runtime over Node and npm",
    flavour: "semantic search · cosine over per-space embeddings",
  },
  {
    name: "remember",
    sig: 'remember({ content: "I deploy on Railway, not Fly.io" })',
    out: 'Stored as memory entry  9f96cbce-251f…',
    flavour: "explicit fact, written by the agent on user prompt",
  },
  {
    name: "observe",
    sig: 'observe({ content: "ran `go build ./cmd/klio`" })',
    out: 'Stored as observation  dfe7849b-edd0…',
    flavour: "auto-fired by the PostToolUse hook · zero token cost",
  },
  {
    name: "plan",
    sig: 'plan({ content: "next: switch space to snowflake-1024" })',
    out: 'Stored as plan  f2c8bb19-91d6…',
    flavour: "forward-looking; another agent can pick it up",
  },
  {
    name: "decide",
    sig: 'decide({ content: "AGPL engine + Apache shim", rationale: "..." })',
    out: 'Stored as decision  b5801f17-46d1…',
    flavour: "carries the why, not just the what",
  },
  {
    name: "note",
    sig: 'note({ content: "TODO: add cursor adapter" })',
    out: 'Stored as note  7a3f2c40-4b89…',
    flavour: "free-form annotation; tagged with agent + timestamp",
  },
  {
    name: "space",
    sig: 'space({ action: "list" })',
    out: '[ default · 768d nomic · 84 entries ]\n[ work    · 1024d snowflake · 12 entries ]',
    flavour: "list / switch / info / request_access",
  },
];

export function BuiltFor() {
  return (
    <section className="k-section">
      <div className="k-container">
        <header style={{ marginBottom: "3.5rem", maxWidth: "62ch" }}>
          <p className="k-eyebrow">the protocol surface · seven mcp tools</p>
          <h2 className="k-h2" style={{ marginTop: "1rem" }}>
            Real calls. Real responses.
          </h2>
          <p className="k-lede" style={{ marginTop: "1.2rem" }}>
            Every Klio tool an agent can invoke, with a representative
            signature and what comes back. No SDK to install per agent —
            the protocol does the integration.
          </p>
        </header>

        <div
          style={{
            border: "1px solid var(--klio-border)",
            borderRadius: "0.5rem",
            overflow: "hidden",
            background: "var(--klio-background)",
          }}
        >
          {TOOLS.map((t, i) => (
            <div
              key={t.name}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(120px, 0.5fr) minmax(0, 1.6fr) minmax(0, 1.4fr)",
                gap: "1.5rem",
                padding: "1.4rem 1.6rem",
                borderTop: i === 0 ? 0 : "1px solid var(--klio-border)",
                alignItems: "start",
              }}
              className="builtfor-row"
            >
              {/* Tool name */}
              <div>
                <div
                  style={{
                    fontFamily: "var(--font-mono-stack)",
                    fontSize: "0.66rem",
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                    color: "var(--klio-faint)",
                    marginBottom: "0.4rem",
                  }}
                >
                  {String(i + 1).padStart(2, "0")} · tool
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono-stack)",
                    fontSize: "1.05rem",
                    fontWeight: 500,
                    color: "var(--klio-foreground)",
                  }}
                >
                  {t.name}
                </div>
                {t.flavour && (
                  <div
                    style={{
                      marginTop: "0.5rem",
                      fontSize: "0.78rem",
                      color: "var(--klio-muted)",
                      lineHeight: 1.45,
                    }}
                  >
                    {t.flavour}
                  </div>
                )}
              </div>

              {/* Signature */}
              <div>
                <div
                  style={{
                    fontFamily: "var(--font-mono-stack)",
                    fontSize: "0.66rem",
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                    color: "var(--klio-faint)",
                    marginBottom: "0.4rem",
                  }}
                >
                  call
                </div>
                <code
                  style={{
                    display: "block",
                    fontFamily: "var(--font-mono-stack)",
                    fontSize: "0.84rem",
                    color: "var(--klio-foreground)",
                    background: "var(--klio-paper)",
                    border: "1px solid var(--klio-border)",
                    padding: "0.55rem 0.8rem",
                    borderRadius: "0.3rem",
                    overflowX: "auto",
                    whiteSpace: "pre",
                  }}
                >
                  {t.sig}
                </code>
              </div>

              {/* Output */}
              <div>
                <div
                  style={{
                    fontFamily: "var(--font-mono-stack)",
                    fontSize: "0.66rem",
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                    color: "var(--klio-faint)",
                    marginBottom: "0.4rem",
                  }}
                >
                  ←
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono-stack)",
                    fontSize: "0.84rem",
                    color: "var(--klio-muted)",
                    whiteSpace: "pre-wrap",
                    lineHeight: 1.55,
                  }}
                >
                  {t.out}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
