import Link from "next/link";

export const metadata = {
  title: "Security · Klio",
  description: "Klio's vulnerability disclosure program, threat model, and security commitments.",
};

export default function SecurityPage() {
  return (
    <main>
      <h1>Security at Klio</h1>

      <h2>Vulnerability Disclosure Program</h2>
      <p style={{ marginBottom: "1rem" }}>
        Klio runs a public Vulnerability Disclosure Program. We will not pursue legal action
        against researchers acting in good faith within the scope below. We respond within
        24 hours, triage within a week, and fix Critical/High issues before public disclosure.
      </p>

      <h2>How to report</h2>
      <ul style={{ paddingLeft: "1.25rem", marginBottom: "1rem" }}>
        <li>Email: <code>security@klio.tech</code></li>
        <li>
          PGP: <Link href="/security/pgp-public-key.asc">our public key</Link>
        </li>
      </ul>

      <h2>In scope</h2>
      <ul style={{ paddingLeft: "1.25rem", marginBottom: "1rem" }}>
        <li>All <code>*.klio.tech</code> domains</li>
        <li><code>klio-bridge</code> daemon binary (any released version)</li>
        <li>The OSS engine in <code>github.com/klio-tech/engine</code></li>
        <li>The protocol specification in <code>github.com/klio-tech/protocol</code></li>
      </ul>

      <h2>Named research targets</h2>
      <p style={{ marginBottom: "0.5rem" }}>
        These are the bugs we most want found:
      </p>
      <ul style={{ paddingLeft: "1.25rem", marginBottom: "1rem" }}>
        <li>Cause user A&apos;s entry to surface in user B&apos;s recall</li>
        <li>Write to a space without write permission</li>
        <li>Read a space without read permission via WebSocket</li>
        <li>Tamper with the audit log without detection</li>
        <li>Memory poisoning that survives the dedup + supersedes pipeline</li>
        <li>Daemon credential exfiltration via local process</li>
      </ul>

      <h2>Recognition</h2>
      <p>
        Klio is currently early-stage and does not have funded bounty payouts. We commit
        publicly to retroactively reward Critical and High findings with cash bounties once
        we close our seed round. Every valid finding is acknowledged on our&nbsp;
        <Link href="/security/hall-of-fame">Hall of Fame</Link>, and we ship swag (t-shirt
        + stickers) for any finding rated Medium or above.
      </p>
    </main>
  );
}
