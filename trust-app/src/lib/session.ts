import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import * as jose from "jose";

const SECRET = process.env.KLIO_JWT_SIGNING_KEY ?? "dev-secret";

export type Session = {
  userId: string;
  accessToken: string;
};

/**
 * Resolve the active session, or null if none.
 *
 * Two paths:
 *   1. Cookie-based magic-link session (production / cloud).
 *   2. Local-dev override: when `KLIO_LOCAL_DEV=1` is set, mint a
 *      JWT in-process for `KLIO_LOCAL_USER_ID`. This is how the
 *      docker-compose'd trust-app authenticates itself without the
 *      user juggling magic-link emails on their own machine. The
 *      JWT we mint is signed with the same shared secret the
 *      engine uses to validate it, so it's a real token, not a
 *      "skip auth" hack — it just bypasses the email round-trip.
 */
export async function getSession(): Promise<Session | null> {
  const local = await getLocalDevSession();
  if (local) return local;

  const cookieStore = await cookies();
  const token = cookieStore.get("klio_session")?.value;
  if (!token) return null;
  try {
    const secret = new TextEncoder().encode(SECRET);
    const { payload } = await jose.jwtVerify(token, secret, { audience: "klio.tech" });
    return { userId: payload.sub as string, accessToken: token };
  } catch {
    return null;
  }
}

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect("/");
  return s;
}

async function getLocalDevSession(): Promise<Session | null> {
  if (process.env.KLIO_LOCAL_DEV !== "1") return null;
  const userId = process.env.KLIO_LOCAL_USER_ID;
  const agentId = process.env.KLIO_LOCAL_AGENT_ID ?? userId;
  if (!userId) return null;
  const secret = new TextEncoder().encode(SECRET);
  // Shape matches what the engine's mint_access_token() emits, so the
  // engine's verify_access_token() accepts it without changes:
  //   sub       = user_id
  //   agent_id  = agent_id (must be a real agent on this user, since
  //               ACL checks happen against this id)
  //   scopes    = ["read", "write"]
  //   aud       = klio.tech
  //   iss       = coordinator.klio.tech
  const accessToken = await new jose.SignJWT({
    agent_id: agentId,
    scopes: ["read", "write"],
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("coordinator.klio.tech")
    .setAudience("klio.tech")
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(secret);
  return { userId, accessToken };
}
