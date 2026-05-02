import { requireSession } from "./session";

const ENGINE_URL = process.env.KLIO_ENGINE_URL ?? "http://127.0.0.1:8000";

export type Space = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
};

export type Permission = {
  id: string;
  space_id: string;
  agent_id: string;
  scope: "read" | "write" | "admin";
  granted_at: string;
};

export type Agent = {
  id: string;
  kind: string;
  display_name: string | null;
  created_at: string;
};

async function authedFetch<T>(path: string): Promise<T> {
  const session = await requireSession();
  const res = await fetch(`${ENGINE_URL}${path}`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  listSpaces: () => authedFetch<Space[]>("/v1/spaces"),
  listAgents: () => authedFetch<Agent[]>("/v1/agents"),
  listPermissions: (spaceId: string) =>
    authedFetch<Permission[]>(`/v1/spaces/${spaceId}/permissions`),
};
