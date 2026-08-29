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
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/config").then(async (r) => {
      if (!r.ok) return;
      // SAFETY: /api/config returns the { githubSignIn, adminEmail } contract.
      const parsed = await r.json() as Config;
      setConfig(parsed);
    }).catch(() => setConfig({ githubSignIn: true, adminEmail: null }));
  }, []);

  async function signInWithToken(event: React.FormEvent) {
    event.preventDefault();
    if (!config?.adminEmail || !token || busy) return;
    setBusy(true);
    setError(undefined);
    const response = await fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: config.adminEmail, password: token, callbackURL: callbackTarget() }),
    }).catch(() => undefined);
    setBusy(false);
    if (response?.ok) { location.assign(callbackTarget()); return; }
    setError("That admin token was not accepted.");
  }

  return (
    <main className="login">
      <Link className="brand" to="/"><SproutboatMark /><span>Sproutboat</span></Link>
      <section>
        <h1>Sign in to your workspace.</h1>
        <p>Deploy JavaScript services as native VPS artifacts, then inspect the routes and versions that are running.</p>
        {config?.githubSignIn && (
          <button className="button primary" type="button" onClick={() => void signInWithGithub()}>Continue with GitHub</button>
        )}
        <form className="admin-signin" onSubmit={signInWithToken}>
          <label htmlFor="admin-token">Admin token</label>
          <input id="admin-token" name="admin-token" type="password" autoComplete="current-password" placeholder="from /root/sproutboat-admin.env" value={token} onChange={(event) => setToken(event.target.value)} />
          <button className={config?.githubSignIn ? "button" : "button primary"} type="submit" disabled={busy || !token}>Sign in as admin</button>
          {error && <p className="form-error" role="alert">{error}</p>}
        </form>
      </section>
    </main>
  );
}
