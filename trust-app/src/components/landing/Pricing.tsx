export function Pricing() {
  return (
    <section
      id="waitlist"
      className="k-section"
      style={{ scrollMarginTop: "4rem" }}
    >
      <div className="k-container">
        <header style={{ marginBottom: "3rem", maxWidth: "60ch" }}>
          <p className="k-eyebrow">pricing scales to zero</p>
          <h2 className="k-h2" style={{ marginTop: "1rem" }}>
            Free local. Paid only when we host.
          </h2>
          <p className="k-lede" style={{ marginTop: "1.2rem" }}>
            Self-hosted Klio is unbounded — unlimited memories, unlimited
            spaces, unlimited agents. Klio Cloud is opt-in for teams that
            want managed Postgres, hosted SSO, and the proprietary
            cross-agent intelligence layer. The OSS will always have a
            working free tier on your laptop.
          </p>
        </header>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: "1.5rem",
          }}
        >
          {/* Free / self-host */}
          <article style={cardStyle("paper")}>
            <div style={planLabel}>self-host · free forever</div>
            <h3
              className="k-h2"
              style={{
                fontSize: "2.2rem",
                marginTop: "0.6rem",
                color: "var(--klio-foreground)",
              }}
            >
              $0
              <span
                style={{
                  fontFamily: "var(--font-mono-stack)",
                  fontSize: "0.85rem",
                  marginLeft: "0.5rem",
                  color: "var(--klio-muted)",
                  fontWeight: 400,
                }}
              >
                / month
              </span>
            </h3>
            <p className="k-lede" style={{ fontSize: "0.95rem", marginTop: "1rem" }}>
              Clone, run, own. Every feature in this page works on day one
              with no account.
            </p>

            <ul style={ul}>
              {[
                "Unlimited memories, spaces, agents",
                "All seven MCP tools",
                "All six Claude Code hooks",
                "Encrypted storage + audit chain",
                "Pluggable embeddings (5 supported models)",
                "Real-time pub/sub on your machine",
              ].map((x) => (
                <li key={x} style={li}>{x}</li>
              ))}
            </ul>

            <a
              className="k-btn k-btn--ghost"
              href="https://github.com/klio-tech/klio"
              target="_blank"
              rel="noreferrer"
              style={{ marginTop: "2rem" }}
            >
              Clone klio-tech/klio →
            </a>
          </article>

          {/* Cloud — waitlist (paper, distinguished by a thicker
              ink border + serif "soon" treatment, not by inverted color) */}
          <article style={cardStyle("emphasis")}>
            <div style={planLabel}>klio cloud · waitlist</div>
            <h3
              style={{
                fontFamily: "var(--font-mono-stack)",
                fontWeight: 700,
                fontSize: "2.2rem",
                lineHeight: 1.05,
                marginTop: "0.6rem",
                color: "var(--klio-foreground)",
                letterSpacing: "-0.025em",
              }}
            >
              soon
              <span
                style={{
                  fontFamily: "var(--font-mono-stack)",
                  fontSize: "0.85rem",
                  marginLeft: "0.5rem",
                  color: "var(--klio-muted)",
                  fontWeight: 400,
                }}
              >
                / per-seat
              </span>
            </h3>
            <p
              className="k-lede"
              style={{ fontSize: "0.95rem", marginTop: "1rem" }}
            >
              Hosted, multi-tenant, with team-scoped spaces, hosted SSO,
              cross-agent intelligence, premium connectors, and managed
              backups across regions.
            </p>

            <ul style={ul}>
              {[
                "Per-project / per-repo space auto-routing",
                "Cross-agent conflict resolution",
                "Premium connectors: Salesforce, Notion, Linear, Slack, Gmail",
                "Team RBAC + hosted SSO (Google · Microsoft · Okta)",
                "Managed multi-region Postgres + AWS KMS",
                "Hosted observability + audit notarization at scale",
              ].map((x) => (
                <li key={x} style={li}>{x}</li>
              ))}
            </ul>

            <a
              href="mailto:contact@klio.tech?subject=Klio Cloud waitlist"
              className="k-btn k-btn--primary"
              style={{ marginTop: "2rem" }}
            >
              Join the waitlist →
            </a>
          </article>
        </div>
      </div>
    </section>
  );
}

function cardStyle(theme: "paper" | "emphasis"): React.CSSProperties {
  const base: React.CSSProperties = {
    background: "var(--klio-background)",
    borderRadius: "0.5rem",
    padding: "2.5rem 2.2rem",
    display: "flex",
    flexDirection: "column",
  };
  return theme === "paper"
    ? { ...base, border: "1px solid var(--klio-border)" }
    : { ...base, border: "2px solid var(--klio-foreground)" };
}

const planLabel: React.CSSProperties = {
  fontFamily: "var(--font-mono-stack)",
  fontSize: "0.72rem",
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--klio-muted)",
};

const ul: React.CSSProperties = {
  listStyle: "none",
  marginTop: "2rem",
  paddingLeft: 0,
  fontSize: "0.92rem",
  lineHeight: 1.6,
  color: "var(--klio-muted)",
  flex: 1,
};

const li: React.CSSProperties = {
  paddingLeft: "1.4rem",
  position: "relative",
  marginBottom: "0.55rem",
};
