import Link from "next/link";

import { api } from "@/lib/api";
import { decideAction } from "./actions";
import { DecideButtons } from "./client";

export default async function AccessRequestsPage() {
  const [requests, agents, spaces] = await Promise.all([
    api.listAccessRequests(),
    api.listAgents(),
    api.listSpaces(),
  ]);
  return (
    <main>
      <Link href="/spaces" className="muted">
        ← Back
      </Link>
      <h1>Pending access requests</h1>
      <p style={{ marginBottom: "2rem" }}>
        When an agent asks to read or write one of your spaces, the request shows up here.
        Approve to grant the requested scope, or deny.
      </p>
      <ul className="list" style={{ listStyle: "none" }}>
        {requests.length === 0 && (
          <li className="list-item muted">No pending requests.</li>
        )}
        {requests.map((r) => {
          const agent = agents.find((a) => a.id === r.agent_id);
          const space = spaces.find((s) => s.id === r.space_id);
          return (
            <li key={r.id} className="list-item" style={{ alignItems: "flex-start" }}>
              <div>
                <div style={{ fontWeight: 600 }}>
                  {agent?.display_name ?? agent?.kind ?? "Unknown agent"}
                  {" "}wants <code>{r.requested_scope}</code> on{" "}
                  <strong>{space?.name ?? r.space_id}</strong>
                </div>
                {r.reason && <div className="muted">{r.reason}</div>}
                <div className="muted">
                  Requested {new Date(r.created_at).toLocaleString()}
                </div>
              </div>
              <DecideButtons requestId={r.id} action={decideAction} />
            </li>
          );
        })}
      </ul>
    </main>
  );
}
