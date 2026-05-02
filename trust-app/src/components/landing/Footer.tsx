import { KlioMark } from "./KlioMark";

const COL_LINKS = {
  Project: [
    { label: "Repository", href: "https://github.com/klio-tech/klio" },
    { label: "README", href: "https://github.com/klio-tech/klio#readme" },
    { label: "Quick start", href: "/?view=human#quick-start" },
    { label: "Roadmap", href: "https://github.com/klio-tech/klio#roadmap" },
  ],
  Open: [
    { label: "License (engine)", href: "https://github.com/klio-tech/klio/blob/main/LICENSE" },
    { label: "License (shim)", href: "https://github.com/klio-tech/klio/blob/main/LICENSE-APACHE-2.0" },
    { label: "Open-core boundary", href: "https://github.com/klio-tech/klio/blob/main/LICENSING.md" },
    { label: "Contributing", href: "https://github.com/klio-tech/klio/blob/main/CONTRIBUTING.md" },
  ],
  Trust: [
    { label: "Security policy", href: "https://github.com/klio-tech/klio/blob/main/SECURITY.md" },
    { label: "Threat model", href: "https://github.com/klio-tech/klio/blob/main/docs/security/threat-model.md" },
    { label: "Embedding models", href: "https://github.com/klio-tech/klio/blob/main/docs/embedding-models.md" },
  ],
  Cloud: [
    { label: "Waitlist", href: "mailto:asingh@oppla.ai?subject=Klio Cloud waitlist" },
    { label: "For teams", href: "mailto:asingh@oppla.ai?subject=Klio for teams" },
    { label: "Commercial license", href: "mailto:asingh@oppla.ai?subject=Klio commercial license" },
  ],
};

export function Footer() {
  return (
    <footer
      style={{
        borderTop: "1px solid var(--klio-border)",
        background: "var(--klio-paper)",
        position: "relative",
        zIndex: 2,
      }}
    >
      <div
        className="k-container"
        style={{ paddingBlock: "5rem 3rem" }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.6fr) repeat(4, minmax(0, 1fr))",
            gap: "2.5rem",
            alignItems: "start",
          }}
          className="footer-grid"
        >
          {/* Wordmark column */}
          <div>
            <a
              href="/"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.7rem",
                color: "var(--klio-foreground)",
              }}
            >
              <KlioMark size={32} />
              <span
                style={{
                  fontFamily: "var(--font-mono-stack)",
                  fontSize: "1.4rem",
                  fontWeight: 700,
                  letterSpacing: "-0.01em",
                  lineHeight: 1,
                }}
              >
                klio
              </span>
            </a>
            <p
              style={{
                marginTop: "1.1rem",
                fontFamily: "var(--font-mono-stack)",
                fontSize: "0.92rem",
                lineHeight: 1.5,
                color: "var(--klio-muted)",
                maxWidth: "32ch",
              }}
            >
              Shared memory for every AI coding agent.
              <br />
              Local-first, encrypted, MCP-native.
            </p>
          </div>

          {/* Link columns */}
          {Object.entries(COL_LINKS).map(([heading, items]) => (
            <div key={heading}>
              <h3
                style={{
                  fontFamily: "var(--font-mono-stack)",
                  fontSize: "0.72rem",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--klio-foreground)",
                  fontWeight: 500,
                  marginBottom: "1.2rem",
                }}
              >
                {heading}
              </h3>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {items.map((l) => (
                  <li key={l.label} style={{ marginBottom: "0.55rem" }}>
                    <a
                      href={l.href}
                      target={l.href.startsWith("http") ? "_blank" : undefined}
                      rel={l.href.startsWith("http") ? "noreferrer" : undefined}
                      style={{
                        fontSize: "0.92rem",
                        color: "var(--klio-muted)",
                      }}
                      className="k-link"
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Colophon */}
        <div
          style={{
            marginTop: "4rem",
            paddingTop: "1.4rem",
            borderTop: "1px solid var(--klio-border)",
            display: "flex",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "1rem",
            fontFamily: "var(--font-mono-stack)",
            fontSize: "0.78rem",
            color: "var(--klio-muted)",
            letterSpacing: "0.02em",
          }}
        >
          <span>
            © {new Date().getFullYear()} Abhishek Singh ·{" "}
            <a
              className="k-link"
              href="mailto:asingh@oppla.ai"
              style={{ color: "var(--klio-muted)" }}
            >
              asingh@oppla.ai
            </a>
          </span>
          <span>
            made with{" "}
            <span style={{ color: "var(--klio-accent)" }}>♥</span>{" "}
            and an absurd amount of coffee
          </span>
        </div>
      </div>
    </footer>
  );
}
