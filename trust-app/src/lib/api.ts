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

export type AccessRequest = {
  id: string;
  agent_id: string;
  space_id: string;
  requested_scope: "read" | "write" | "admin";
  reason: string | null;
  status: "pending" | "approved" | "denied" | "expired";
  created_at: string;
  decided_at: string | null;
};

async function authedFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const session = await requireSession();
  const res = await fetch(`${ENGINE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  listSpaces: () => authedFetch<Space[]>("/v1/spaces"),
  listAgents: () => authedFetch<Agent[]>("/v1/agents"),
  listPermissions: (spaceId: string) =>
    authedFetch<Permission[]>(`/v1/spaces/${spaceId}/permissions`),
  listAccessRequests: () => authedFetch<AccessRequest[]>("/v1/access-requests"),
  approveAccessRequest: (id: string, grantScope?: "read" | "write" | "admin") =>
    authedFetch<AccessRequest>(`/v1/access-requests/${id}/approve`, {
      method: "POST",
      body: JSON.stringify(grantScope ? { grant_scope: grantScope } : {}),
    }),
  denyAccessRequest: (id: string) =>
    authedFetch<AccessRequest>(`/v1/access-requests/${id}/deny`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
};
