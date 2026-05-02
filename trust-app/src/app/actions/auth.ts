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
  // The engine's /v1/users/{user_id}/claim is per-user. For the trust app's
  // login flow, we don't yet know the user_id — we'd add a /v1/auth/login-link
  // endpoint that looks the user up by email_hash. Phase L wires that.
  // For now, we just acknowledge to the user that we'd send the link.
  return { ok: true, error: null };
}
