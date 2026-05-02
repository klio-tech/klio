"use client";

import { useActionState } from "react";

import { requestLoginLink } from "@/app/actions/auth";

type State = { ok: boolean; error: string | null } | null;

export function LoginForm() {
  const [state, formAction, isPending] = useActionState<State, FormData>(
    requestLoginLink,
    null,
  );
  return (
    <form action={formAction} className="card" style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" type="email" name="email" required autoComplete="email" placeholder="you@example.com" />
      </div>
      <button type="submit" disabled={isPending}>
        {isPending ? "Sending…" : "Send magic link"}
      </button>
      {state?.error && <p className="error">{state.error}</p>}
      {state?.ok && <p className="success">Check your email for a sign-in link.</p>}
    </form>
  );
}
