import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Avatar, Button, PanelHeading, TextField } from "../components";
import { useAccount } from "../dashboard-data";

export const Route = createFileRoute("/profile")({ component: Profile, head: () => ({ meta: [{ title: "Profile · Sproutboat" }] }) });

const USERNAME_RULE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;

function Profile() {
  const { account, refresh } = useAccount();
  const [profile, setProfile] = useState<{ username: string }>();
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = username.trim().toLowerCase();
  const invalid = trimmed !== "" && !USERNAME_RULE.test(trimmed);

  const reserve = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!USERNAME_RULE.test(trimmed)) { setError("Use 3–32 lowercase letters, digits or hyphens."); return; }
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/account/namespace", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ username: trimmed }),
      });
      if (!response.ok) {
        // SAFETY: an error body from this endpoint is { error: string }.
        const body = await response.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? "Choose an available 3–32 character lowercase namespace.");
        return;
      }
      // SAFETY: successful namespace reservation returns the updated profile contract.
      const body = await response.json() as { profile: { username: string } };
      setProfile(body.profile);
      refresh();
    } catch {
      setError("Could not reach the control plane. Try again.");
    } finally { setBusy(false); }
  };

  const currentProfile = profile ?? account?.profile;
  const identityLabel = currentProfile?.username || account?.user?.name || "account";

  return (
    <>
      <section className="page-heading">
        <div><h1>Profile</h1><p>Your deployment namespace is used in every project route.</p></div>
      </section>
      <section className="data-panel settings-panel">
        {currentProfile ? (
          <>
            <div className="profile-identity">
              <span className="profile-avatar"><Avatar image={account?.user?.image} label={identityLabel} /></span>
              <div>
                <h2>{currentProfile.username}</h2>
                {account?.user?.name && <p>{account.user.name}{account.user.email ? ` · ${account.user.email}` : ""}</p>}
              </div>
            </div>
            <p className="hint">Namespace changes are unavailable while deployments exist.</p>
          </>
        ) : (
          <>
            <PanelHeading
              title="Claim your namespace"
              description={<>Choose the name that will appear in routes such as <code>hello.name.sproutboat.com</code>.</>}
            />
            <form className="form-grid namespace-input" onSubmit={(event) => void reserve(event)}>
              <TextField
                label="Namespace"
                value={username}
                onChange={(event) => { setUsername(event.target.value); setError(null); }}
                placeholder="andrea"
                autoComplete="off"
                spellCheck={false}
                required
                hint="3–32 characters: lowercase letters, digits and hyphens."
                error={invalid ? "Use 3–32 lowercase letters, digits or hyphens." : error}
              />
              <div className="form-actions">
                <Button type="submit" variant="primary" busy={busy} busyLabel="Reserving…" disabled={!trimmed || invalid}>Reserve</Button>
              </div>
            </form>
          </>
        )}
        <p><Link className="text-link" to="/settings">Appearance settings</Link></p>
      </section>
    </>
  );
}
