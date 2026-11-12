import { Button, Field, Input, SensitiveInput } from "@sproutboat/ikada";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useJson } from "../dashboard-data";
import { SproutboatMark } from "../shell";

export const Route = createFileRoute("/login")({
  component: Login,
  head: () => ({ meta: [{ title: "Sign in · Sproutboat" }] }),
});

function callbackTarget(): string {
  const cliCode = new URLSearchParams(location.search).get("cli_code");
  return cliCode
    ? `${location.origin}/cli-authorize?cli_code=${encodeURIComponent(cliCode)}`
    : `${location.origin}/profile`;
}

async function signInWithGithub() {
  const response = await fetch("/api/auth/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "github", callbackURL: callbackTarget() }),
  });
  if (!response.ok) return;
  // SAFETY: successful sign-in returns an optional OAuth redirect URL.
  const data = (await response.json()) as { url?: string };
  if (data.url) location.assign(data.url);
}

type Config = { githubSignIn: boolean; adminEmail: string | null };
const FALLBACK_CONFIG: Config = { githubSignIn: true, adminEmail: null };

function Login() {
  const { data: configData, state: configState } = useJson<Config>("/api/config");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const config = configData ?? (configState === "error" ? FALLBACK_CONFIG : undefined);

  useEffect(() => {
    if (config) setEmail((current) => current || config.adminEmail || "");
  }, [config]);

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
      if (response?.ok) {
        location.assign(callbackTarget());
        return;
      }
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
    <main id="content" className="flex min-h-dvh flex-col items-center justify-center gap-6 p-5 sm:p-8">
      <Link
        to="/"
        className="inline-flex items-center gap-2.5 rounded-md text-xl font-bold outline-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <SproutboatMark />
        <span>sproutboat</span>
      </Link>
      <section className="w-full max-w-sm rounded-xl bg-surface p-6 shadow-card sm:p-8">
        <h1 className="text-xl font-bold">Sign in to your workspace</h1>
        <p className="mt-2 mb-6 text-base text-fg-muted">
          Accounts are created by the admin. There is no self-service sign-up.
        </p>
        {config?.githubSignIn && (
          <>
            <Button variant="primary" className="w-full" onClick={() => void signInWithGithub()}>
              Continue with GitHub
            </Button>
            <p className="my-5 flex items-center gap-3 text-sm text-fg-muted before:h-px before:flex-1 before:bg-hairline before:content-[''] after:h-px after:flex-1 after:bg-hairline after:content-['']">
              <span>or</span>
            </p>
          </>
        )}
        <form className="flex flex-col gap-4" onSubmit={signInWithPassword}>
          <Field label="Email" required>
            <Input
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setError(undefined);
              }}
            />
          </Field>
          <Field
            label="Password"
            required
            error={error}
            description={
              adminHint ? (
                <>
                  Admin: your password is the token from <code>/root/sproutboat-admin.env</code>.
                </>
              ) : undefined
            }
          >
            <SensitiveInput
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setError(undefined);
              }}
            />
          </Field>
          <Button
            type="submit"
            className="mt-2 w-full"
            variant={config?.githubSignIn ? "secondary" : "primary"}
            loading={busy}
            disabled={!email || !password}
          >
            Sign in
          </Button>
        </form>
      </section>
    </main>
  );
}
