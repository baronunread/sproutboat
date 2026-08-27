import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home, head: () => ({ meta: [{ title: "Porffer" }] }) });

function Home() {
  const [signedIn, setSignedIn] = useState(false); const [hasNamespace, setHasNamespace] = useState(false); const [username, setUsername] = useState("");
  useEffect(() => { void fetch("/v1/me", { credentials: "include" }).then(async (response) => { setSignedIn(response.ok); return response.ok ? response.json() : null; }).then((data) => setHasNamespace(Boolean(data?.profile))); }, []);
  const signIn = async () => { const response = await fetch("/api/auth/sign-in/social", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "github", callbackURL: location.origin }) }); const data = await response.json() as { url?: string }; if (data.url) location.assign(data.url); };
  const reserve = async () => { const response = await fetch("/v1/me/namespace", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ username }) }); if (response.ok) setHasNamespace(true); };
  return <main><p className="eyebrow">Porffer</p><h1>Deploy native JavaScript.</h1><p className="lede">Compile small HTTP services locally, then run them as isolated Porffers.</p>{!signedIn && <button className="button primary" type="button" onClick={signIn}>Sign in with GitHub</button>}{signedIn && !hasNamespace && <section className="panel"><h2>Choose a namespace</h2><p>Your Porffers will use <code>project.{username || "name"}.porffer.dev</code>.</p><input aria-label="Namespace" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="andrea" /><button className="button primary" type="button" onClick={reserve}>Reserve namespace</button></section>}{hasNamespace && <Link className="button primary" to="/dashboard">Open dashboard</Link>}</main>;
}
