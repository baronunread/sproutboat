import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SproutboatMark } from "../components";

export const Route = createFileRoute("/login")({ component: Login, head: () => ({ meta: [{ title: "Sign in · Sproutboat" }] }) });

function callbackTarget(): string {
  const cliCode = new URLSearchParams(location.search).get("cli_code");
  return cliCode ? `${location.origin}/?cli_code=${encodeURIComponent(cliCode)}` : `${location.origin}/profile`;
}

async function signInWithGithub() {
  const response = await fetch("/api/auth/sign-in/social", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "github", callbackURL: callbackTarget() }) });
  if (!response.ok) return;
  // SAFETY: successful sign-in returns an optional OAuth redirect URL.
  const data = await response.json() as { url?: string };
  if (data.url) location.assign(data.url);
}

type Config = { githubSignIn: boolean; adminEmail: string | null };

function Login() {
  const [config, setConfig] = useState<Config>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/config").then(async (r) => {
      if (!r.ok) return;
      // SAFETY: /api/config returns the { githubSignIn, adminEmail } contract.
      const parsed = await r.json() as Config;
      setConfig(parsed);
      setEmail((current) => current || parsed.adminEmail || "");
    }).catch(() => setConfig({ githubSignIn: true, adminEmail: null }));
  }, []);

  async function signInWithPassword(event: React.FormEvent) {
    event.preventDefault();
    if (!email || !password || busy) return;
    setBusy(true);
    setError(undefined);
    const response = await fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, callbackURL: callbackTarget() }),
    }).catch(() => undefined);
    setBusy(false);
    if (response?.ok) { location.assign(callbackTarget()); return; }
    setError("That email and password did not match.");
  }

  const adminHint = config?.adminEmail && email === config.adminEmail;

  return (
    <main className="login">
      <Link className="brand" to="/"><SproutboatMark /><span>Sproutboat</span></Link>
      <section>
        <h1>Sign in to your workspace.</h1>
        <p>Accounts are created by the admin — there is no self-service sign-up.</p>
        {config?.githubSignIn && (
          <>
            <button className="button primary" type="button" onClick={() => void signInWithGithub()}>Continue with GitHub</button>
            <p className="or-divider"><span>or</span></p>
          </>
        )}
        <form className="password-signin" onSubmit={signInWithPassword}>
          <label htmlFor="signin-email">Email</label>
          <input id="signin-email" name="email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} />
          <label htmlFor="signin-password">Password</label>
          <input id="signin-password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          {adminHint && <p className="hint">Admin: your password is the token from <code>/root/sproutboat-admin.env</code>.</p>}
          <button className={config?.githubSignIn ? "button" : "button primary"} type="submit" disabled={busy || !email || !password}>Sign in</button>
          {error && <p className="form-error" role="alert">{error}</p>}
        </form>
      </section>
    </main>
  );
}
