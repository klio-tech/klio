// Minimal HTTP client for the engine's REST API. We only need two
// calls from the npm path: GET /health (orchestrator wait loop) and
// POST /v1/users/provision (account creation). Both use Node's
// built-in fetch (Node 20+) so the package keeps zero runtime deps.

import { setTimeout as sleep } from "node:timers/promises";

export type ProvisionRequest = {
  agentKind: string;
  installID: string;
  email?: string;
};

export type ProvisionResponse = {
  user_id: string;
  agent_id: string;
  default_space_id: string;
  api_key: string;
};

/**
 * Poll the engine's /health endpoint until it returns 200 + status=ok,
 * or the timeout elapses. The orchestrator calls this right after
 * `docker compose up` so the next steps (provision, configure
 * keychain) don't race the engine's uvicorn start + alembic migrate.
 *
 * Why 500ms intervals: the engine's /health responds in <1ms once
 * up, so a tighter interval just burns CPU. 500ms gives ~15s
 * resolution on a 90s timeout.
 */
export async function waitForEngineHealth(
  url: string,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "not started";
  const healthURL = url.replace(/\/+$/, "") + "/health";

  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2_000);
      const res = await fetch(healthURL, { signal: ctrl.signal });
      clearTimeout(timer);

      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        if (body.status === "ok") return;
        lastErr = `unexpected status: ${body.status}`;
      } else {
        lastErr = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await sleep(500);
  }
  throw new Error(
    `engine did not become healthy within ${Math.round(timeoutMs / 1000)}s. Last error: ${lastErr}`,
  );
}

/**
 * Mint a fresh anonymous account against the local engine. The
 * engine generates the user/agent UUIDs, a default space, and a
 * refresh token. The token is then handed to the bridge container
 * via `klio configure ...` (see commands/init.ts).
 *
 * `installID` is a stable per-machine UUID we generate once and
 * persist alongside the credentials, so re-running `npx klio init`
 * idempotently re-uses the same account rather than minting a new
 * one each time.
 */
export async function provision(
  engineURL: string,
  req: ProvisionRequest,
): Promise<ProvisionResponse> {
  const body = JSON.stringify({
    agent_kind: req.agentKind,
    install_id: req.installID,
    ...(req.email ? { email: req.email } : {}),
  });

  const res = await fetch(
    engineURL.replace(/\/+$/, "") + "/v1/users/provision",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `provision failed: HTTP ${res.status} from ${engineURL}\n${text.trim()}`,
    );
  }

  const data = (await res.json()) as ProvisionResponse;
  for (const k of ["user_id", "agent_id", "default_space_id", "api_key"] as const) {
    if (!data[k]) {
      throw new Error(`provision response missing ${k}: ${JSON.stringify(data)}`);
    }
  }
  return data;
}
