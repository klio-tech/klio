import Link from "next/link";

export const metadata = {
  title: "Hall of Fame · Klio Security",
};

export default function HallOfFamePage() {
  return (
    <main>
      <Link href="/security" className="muted">
        ← Back to security
      </Link>
      <h1>Hall of Fame</h1>
      <p>Researchers who reported valid vulnerabilities to Klio are listed here.</p>
      <ul className="list" style={{ marginTop: "2rem", listStyle: "none" }}>
        <li className="list-item muted">Be the first.</li>
      </ul>
    </main>
  );
}
