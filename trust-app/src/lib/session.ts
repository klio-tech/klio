import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import * as jose from "jose";

const SECRET = process.env.KLIO_JWT_SIGNING_KEY ?? "dev-secret";

export type Session = {
  userId: string;
  accessToken: string;
};

export async function getSession(): Promise<Session | null> {
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
