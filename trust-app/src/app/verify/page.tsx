import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const ENGINE_URL = process.env.KLIO_ENGINE_URL ?? "http://127.0.0.1:8000";

type SearchParams = Promise<{ token?: string; user_id?: string }>;

export default async function VerifyPage({ searchParams }: { searchParams: SearchParams }) {
  const { token, user_id: userId } = await searchParams;
  if (!token || !userId) {
    return (
      <main>
        <h1>Sign in</h1>
        <p className="error">Missing token. Please request a new link.</p>
      </main>
    );
  }
  const res = await fetch(`${ENGINE_URL}/v1/users/${userId}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    cache: "no-store",
  });
  if (!res.ok) {
    return (
      <main>
        <h1>Sign in</h1>
        <p className="error">Invalid or expired link. Request a new one from the home page.</p>
      </main>
    );
  }
  const body = (await res.json()) as { session_token: string };
  const cookieStore = await cookies();
  cookieStore.set("klio_session", body.session_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 30 * 24 * 60 * 60,
    path: "/",
  });
  redirect("/spaces");
}
