"use server";

import { z } from "zod";

const Schema = z.object({ email: z.string().email() });

const ENGINE_URL = process.env.KLIO_ENGINE_URL ?? "http://127.0.0.1:8000";

type State = { ok: boolean; error: string | null } | null;

export async function requestLoginLink(_prev: State, formData: FormData): Promise<State> {
  const parsed = Schema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { ok: false, error: "Please enter a valid email." };
  }

  try {
    const res = await fetch(`${ENGINE_URL}/v1/auth/login-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: parsed.data.email }),
      cache: "no-store",
    });
    if (!res.ok) {
      // The endpoint always returns 200 for valid input — non-200 means a
      // server problem we should surface generically.
      return { ok: false, error: "Could not send a link right now. Try again." };
    }
  } catch {
    return { ok: false, error: "Could not reach Klio. Try again." };
  }

  // Always show the same success message — by design we don't reveal whether
  // the email matched a registered user.
  return { ok: true, error: null };
}
