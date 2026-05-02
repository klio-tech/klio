import Link from "next/link";

import { api } from "@/lib/api";

export default async function SpacesPage() {
  const spaces = await api.listSpaces();
  return (
    <main>
      <h1>Your Spaces</h1>
      <p style={{ marginBottom: "2rem" }}>
        A space is a container for memory. Each space has its own access controls — you choose
        which agents can read or write each one.
      </p>
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
