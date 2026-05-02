import { LoginForm } from "@/components/login-form";

export default function LandingPage() {
  return (
    <main style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: "6rem" }}>
      <div style={{ maxWidth: "28rem", width: "100%" }}>
        <div style={{ textAlign: "center", marginBottom: "2rem" }}>
          <h1>Klio</h1>
          <p>Your AI agents, finally talking to each other.</p>
        </div>
        <LoginForm />
        <p className="muted" style={{ textAlign: "center", marginTop: "1rem", fontSize: "0.75rem" }}>
          We&apos;ll email you a magic link. No passwords, ever.
        </p>
      </div>
    </main>
  );
}
