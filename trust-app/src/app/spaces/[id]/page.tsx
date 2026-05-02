import Link from "next/link";

import { api } from "@/lib/api";

type Params = Promise<{ id: string }>;

export default async function SpaceDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const [spaces, agents, permissions] = await Promise.all([
    api.listSpaces(),
    api.listAgents(),
    api.listPermissions(id),
  ]);
  const space = spaces.find((s) => s.id === id);
  if (!space) {
    return (
      <main>
        <h1>Not found</h1>
        <p>This space doesn&apos;t exist or you don&apos;t have access.</p>
        <Link href="/spaces">← Back to spaces</Link>
      </main>
    );
  }
  return (
    <main>
      <Link href="/spaces" className="muted">
        ← Back
      </Link>
      <h1>{space.name}</h1>
      <p className="muted">Slug: {space.slug}</p>

      <h2>Agents with access</h2>
      <ul className="list" style={{ listStyle: "none" }}>
        {permissions.map((p) => {
          const agent = agents.find((a) => a.id === p.agent_id);
          return (
            <li key={p.id} className="list-item">
              <div>
                <div style={{ fontWeight: 500 }}>
                  {agent?.display_name ?? agent?.kind ?? "Unknown"}
                </div>
                <div className="muted">
                  scope: {p.scope} · granted {new Date(p.granted_at).toLocaleDateString()}
                </div>
              </div>
            </li>
          );
        })}
        {permissions.length === 0 && (
          <li className="list-item muted">No agents have access yet.</li>
        )}
      </ul>
    </main>
  );
}
