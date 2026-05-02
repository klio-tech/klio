import Link from "next/link";

import { api } from "@/lib/api";

export default async function SpacesPage() {
  const [spaces, requests] = await Promise.all([
    api.listSpaces(),
    api.listAccessRequests().catch(() => []),
  ]);
  return (
    <main>
      <h1>Your Spaces</h1>
      <p style={{ marginBottom: "1rem" }}>
        A space is a container for memory. Each space has its own access controls — you choose
        which agents can read or write each one.
      </p>
      {requests.length > 0 && (
        <p style={{ marginBottom: "2rem" }}>
          <Link
            href="/access-requests"
            style={{
              display: "inline-block",
              padding: "0.5rem 0.75rem",
              borderRadius: "0.375rem",
              background: "var(--muted)",
              color: "var(--foreground)",
              fontWeight: 500,
            }}
          >
            {requests.length} pending access request{requests.length === 1 ? "" : "s"} →
          </Link>
        </p>
      )}
      <ul className="list" style={{ listStyle: "none" }}>
        {spaces.map((s) => (
          <li key={s.id}>
            <Link href={`/spaces/${s.id}`} className="list-item">
              <div>
                <div style={{ fontWeight: 600 }}>{s.name}</div>
                <div className="muted">
                  Created {new Date(s.created_at).toLocaleDateString()} · slug: {s.slug}
                </div>
              </div>
              <span className="muted">→</span>
            </Link>
          </li>
        ))}
        {spaces.length === 0 && (
          <li className="list-item muted">No spaces yet. Run `npx klio init` to provision one.</li>
        )}
      </ul>
    </main>
  );
}
