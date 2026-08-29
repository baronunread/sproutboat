import { useState } from "react";
import { createFileRoute, Link, useLoaderData } from "@tanstack/react-router";
import { Avatar, Shell } from "../components";

export const Route = createFileRoute("/profile")({ component: Profile, head: () => ({ meta: [{ title: "Profile · Sproutboat" }] }) });
function Profile() {
  const account = useLoaderData({ from: "__root__" });
  const [profile, setProfile] = useState<{ username: string }>();
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const reserve = async () => { setError(""); const response = await fetch("/api/account/namespace", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ username }) }); if (response.ok) { // SAFETY: successful namespace reservation returns the updated profile contract.
      setProfile((await response.json() as { profile: { username: string } }).profile);
    } else setError("Choose an available 3–32 character lowercase namespace."); };
  const currentProfile = profile ?? account?.profile;
  const identityLabel = currentProfile?.username || account?.user?.name || "account";
  return <Shell><section className="page-heading"><div><h1>Profile</h1><p>Your deployment namespace is used in every project route.</p></div></section><section className="data-panel settings-panel">{currentProfile ? <><div className="profile-identity"><span className="profile-avatar"><Avatar image={account?.user?.image} label={identityLabel} /></span><div><h2>{currentProfile.username}</h2>{account?.user?.name && <p>{account.user.name}{account.user.email ? ` · ${account.user.email}` : ""}</p>}</div></div><p>Namespace changes are unavailable while deployments exist.</p></> : <><h2>Claim your namespace</h2><p>Choose the name that will appear in routes such as <code>hello.name.sproutboat.com</code>.</p><form className="namespace-input" onSubmit={(event) => { event.preventDefault(); void reserve(); }}><input aria-label="Namespace" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="andrea" required /><button className="button primary" type="submit">Reserve</button></form>{error && <p className="form-error" role="alert">{error}</p>}</>}<p><Link className="text-link" to="/settings">Appearance settings</Link></p></section></Shell>;
}
