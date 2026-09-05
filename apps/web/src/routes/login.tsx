import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button, SproutboatMark, TextField } from "../components";

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
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, callbackURL: callbackTarget() }),
      }).catch(() => undefined);
      if (response?.ok) { location.assign(callbackTarget()); return; }
      setError("That email and password did not match.");
    } finally {
      setBusy(false);
    }
  }

  const adminHint = config?.adminEmail && email === config.adminEmail;

  return (
    // id="content" is the skip link's target: __root always renders the link,
    // and /login is the one route that supplies its own <main> instead of the
    // Shell's, so without this the link had nothing to jump to here.
    <main id="content" className="grid min-h-screen place-items-center p-8">
      <Link className="absolute top-6 left-6 inline-flex items-center gap-2.5 text-[0.95rem] font-extrabold tracking-tight no-underline" to="/"><SproutboatMark /><span>Sproutboat</span></Link>
      <section className="w-full max-w-[27rem] rounded-xl border border-border bg-card p-8 [&>h1]:m-0 [&>h1]:max-w-[12ch] [&>h1]:text-[2rem] [&>h1]:leading-none [&>h1]:font-bold [&>h1]:tracking-[-0.035em] [&>p]:mb-6 [&>p]:text-[0.875rem] [&>p]:leading-relaxed [&>p]:text-muted-foreground">
        <h1>Sign in to your workspace.</h1>
        <p>Accounts are created by the admin — there is no self-service sign-up.</p>
        {config?.githubSignIn && (
          <>
            <Button variant="primary" className="w-full" onClick={() => void signInWithGithub()}>Continue with GitHub</Button>
            <p className="my-5 flex items-center gap-3 text-[0.75rem] text-muted-foreground before:h-px before:flex-1 before:bg-border before:content-[''] after:h-px after:flex-1 after:bg-border after:content-['']"><span>or</span></p>
          </>
        )}
        <form className="mt-5 grid max-w-[36rem] gap-5 [&>[data-slot=form-actions]]:col-span-full" onSubmit={signInWithPassword}>
          <TextField
            label="Email"
            id="signin-email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => { setEmail(event.target.value); setError(undefined); }}
          />
          <TextField
            label="Password"
            id="signin-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => { setPassword(event.target.value); setError(undefined); }}
            hint={adminHint ? <>Admin: your password is the token from <code>/root/sproutboat-admin.env</code>.</> : undefined}
            error={error ?? null}
          />
          <div data-slot="form-actions" className="mt-1 flex flex-wrap items-center gap-2.5">
            <Button type="submit" className="w-full" variant={config?.githubSignIn ? "quiet" : "primary"} busy={busy} busyLabel="Signing in…" disabled={!email || !password}>
              Sign in
            </Button>
          </div>
        </form>
      </section>
    </main>
  );
}
