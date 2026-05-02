import Link from "next/link";

const LINKS = [
  { label: "Docs", href: "https://github.com/klio-tech/klio#readme" },
  { label: "GitHub", href: "https://github.com/klio-tech/klio" },
  { label: "Cloud", href: "/?view=human#waitlist" },
];

export function LandingHeader() {
  return (
    <header
      style={{
        position: "relative",
        zIndex: 4,
        paddingBlock: "1.6rem",
        borderBottom: "1px solid var(--klio-border)",
      }}
    >
      <div
        className="k-container"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <Link
          href="/"
          aria-label="Klio home"
          style={{
            fontFamily: "var(--font-mono-stack)",
            fontSize: "1.05rem",
            fontWeight: 500,
            letterSpacing: "-0.005em",
            color: "var(--klio-foreground)",
          }}
        >
          klio<span style={{ color: "var(--klio-accent)" }}>.</span>
        </Link>

        <nav
          style={{
            display: "flex",
            alignItems: "center",
            gap: "1.6rem",
            fontFamily: "var(--font-sans-stack)",
            fontSize: "0.92rem",
          }}
        >
          {LINKS.map((l) => {
            const external = l.href.startsWith("http");
            return external ? (
              <a
                key={l.label}
                href={l.href}
                target="_blank"
                rel="noreferrer"
                className="k-link"
              >
                {l.label}
              </a>
            ) : (
              <Link key={l.label} href={l.href} className="k-link">
                {l.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
