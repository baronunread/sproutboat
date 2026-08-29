import { createFileRoute, Link } from "@tanstack/react-router";
import { SproutboatMark } from "../components";

export const Route = createFileRoute("/login")({ component: Login, head: () => ({ meta: [{ title: "Sign in · Sproutboat" }] }) });
async function signIn() {
  const cliCode = new URLSearchParams(location.search).get("cli_code");
  const callbackURL = cliCode ? `${location.origin}/?cli_code=${encodeURIComponent(cliCode)}` : `${location.origin}/profile`;
  const response = await fetch("/api/auth/sign-in/social", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "github", callbackURL }) });
  if (!response.ok) return;
  // SAFETY: successful sign-in returns an optional OAuth redirect URL.
  const data = await response.json() as { url?: string };
  if (data.url) location.assign(data.url);
}
function Login() { return <main className="login"><Link className="brand" to="/"><SproutboatMark /><span>Sproutboat</span></Link><section><h1>Sign in to your workspace.</h1><p>Deploy JavaScript services as native VPS artifacts, then inspect the routes and versions that are running.</p><button className="button primary" type="button" onClick={() => void signIn()}>Continue with GitHub</button></section></main>; }
