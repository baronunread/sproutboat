import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Shell } from "../components";

export const Route = createFileRoute("/profile")({ component: Profile, head: () => ({ meta: [{ title: "Profile · Sproutboat" }] }) });
function Profile() {
  const [profile, setProfile] = useState<{ username: string }>();
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { void fetch("/v1/me", { credentials: "include" }).then((response) => response.ok ? response.json() : undefined).then((data) => setProfile(data?.profile)).catch(() => undefined); }, []);
  const reserve = async () => { setError(""); const response = await fetch("/v1/me/namespace", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ username }) }); if (response.ok) setProfile((await response.json() as { profile: { username: string } }).profile); else setError("Choose an available 3–32 character lowercase namespace."); };
  return <Shell><section className="page-heading"><div><h1>Profile</h1><p>Your deployment namespace is used in every project route.</p></div></section><section className="data-panel settings-panel">{profile ? <><h2>{profile.username}</h2><p>Namespace changes are unavailable while deployments exist.</p></> : <><h2>Claim your namespace</h2><p>Choose the name that will appear in routes such as <code>hello.name.sproutboat.com</code>.</p><form className="namespace-input" onSubmit={(event) => { event.preventDefault(); void reserve(); }}><input aria-label="Namespace" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="andrea" required /><button className="button primary" type="submit">Reserve</button></form>{error && <p className="form-error" role="alert">{error}</p>}</>}<p><Link className="text-link" to="/settings">Appearance settings</Link></p></section></Shell>;
}
