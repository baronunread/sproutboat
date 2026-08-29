import { useCallback, useEffect, useState, type FormEvent } from "react";
import { relativeTime } from "./dashboard-data";

type Credential = {
  id: string; name: string | null; prefix: string | null; start: string | null;
  createdAt: string; lastUsedAt: string | null; expiresAt: string | null; enabled: boolean;
};

/**
 * #21: list and revoke the CLI credentials Better Auth issued for
 * `sproutboat login`. Revocation is immediate. The browser session is a
 * separate credential and is never listed or revoked here.
 */
export function CliCredentials() {
  const [items, setItems] = useState<Credential[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const response = await fetch("/api/account/credentials", { credentials: "include" });
      if (!response.ok) { setState("error"); return; }
      // SAFETY: a 2xx here is the { credentials: Credential[] } contract.
      const body = await response.json() as { credentials: Credential[] };
      setItems(body.credentials); setState("ready");
    } catch { setState("error"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const revoke = async (id: string, label: string) => {
    if (!confirm(`Revoke "${label}"? Any machine using it must run sproutboat login again.`)) return;
    setNote(""); setBusy(id);
    try {
      const response = await fetch(`/api/account/credentials/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "include" });
      setBusy("");
      if (!response.ok) { setNote("Could not revoke that credential. Try again."); return; }
      setNote(`Revoked "${label}".`);
      await load();
    } catch { setBusy(""); setNote("Could not reach the control plane. Try again."); }
  };

  const revokeAll = async () => {
    if (!confirm("Revoke every CLI credential? Every machine must run sproutboat login again.")) return;
    setNote(""); setBusy("all");
    try {
      const response = await fetch("/api/account/credentials", { method: "DELETE", credentials: "include" });
      setBusy("");
      if (!response.ok) { setNote("Could not revoke the credentials. Try again."); return; }
      // SAFETY: a 2xx from the revoke-all endpoint is { revoked: number }.
      const body = await response.json() as { revoked: number };
      setNote(`Revoked ${body.revoked} credential${body.revoked === 1 ? "" : "s"}.`);
      await load();
    } catch { setBusy(""); setNote("Could not reach the control plane. Try again."); }
  };

  return (
    <section className="data-panel settings-panel">
      <div className="panel-heading">
        <div><h2>CLI credentials</h2><p>API keys created by <code>sproutboat login</code>. Your browser session is separate and stays signed in.</p></div>
        {state === "ready" && items.length > 0 && (
          <button type="button" className="button quiet" disabled={busy !== ""} onClick={() => void revokeAll()}>Revoke all</button>
        )}
      </div>
      {note && <p className="form-status" role="status">{note}</p>}
      {state === "loading" ? (
        <p className="loading-state" aria-live="polite">Loading credentials…</p>
      ) : state === "error" ? (
        <p className="form-error" role="alert">Could not load credentials. Refresh and try again.</p>
      ) : items.length === 0 ? (
        <p className="empty-state">No CLI credentials yet. Run <code>sproutboat login</code> on a machine to create one.</p>
      ) : (
        <ul className="credential-list">
          {items.map((credential) => {
            const label = credential.name || credential.start || credential.id.slice(0, 8);
            return (
              <li key={credential.id}>
                <div>
                  <strong>{label}</strong>
                  <small>{credential.start ?? credential.prefix ?? "sproutboat_…"} · created {relativeTime(credential.createdAt)}</small>
                </div>
                <span>{credential.lastUsedAt ? `Last used ${relativeTime(credential.lastUsedAt)}` : "Never used"}</span>
                <span>{credential.expiresAt ? `Expires ${credential.expiresAt.slice(0, 10)}` : "No expiry"}</span>
                <button type="button" className="text-button danger" disabled={busy !== ""} onClick={() => void revoke(credential.id, label)}>
                  {busy === credential.id ? "Revoking…" : "Revoke"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * #16 account deletion: typed-username confirmation, then DELETE /api/account. The
 * server clears the session cookie in its response, so on success we go straight
 * to /login (the root auth gate keeps us there). The 403 path only reaches a
 * CLI-token caller, but is handled for completeness.
 */
export function DeleteAccount({ username }: { username?: string }) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const expected = username ?? "";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(""); setBusy(true);
    try {
      const response = await fetch("/api/account", { method: "DELETE", credentials: "include" });
      if (response.ok) { location.assign("/login"); return; }
      setBusy(false);
      setError(response.status === 403
        ? "Account deletion is only available from an interactive browser session, not a CLI token."
        : "Could not delete your account. Try again.");
    } catch {
      setBusy(false);
      setError("Could not reach the control plane. Try again.");
    }
  };

  return (
    <section className="data-panel settings-panel">
      <h2>Delete account</h2>
      <p>
        This permanently removes your namespace, every project and deployment, all routed hostnames, and every issued CLI
        credential. Active routes stop serving immediately and you are signed out. This cannot be undone.
      </p>
      <form className="danger-confirm" onSubmit={submit}>
        <label htmlFor="delete-account-confirm">Type <strong>{expected || "your username"}</strong> to confirm.</label>
        <div className="danger-confirm-row">
          <input id="delete-account-confirm" value={confirm} autoComplete="off" spellCheck={false} placeholder={expected}
            aria-invalid={error ? true : undefined} onChange={(event) => setConfirm(event.target.value)} />
          <button type="submit" className="button danger" disabled={busy || !expected || confirm !== expected}>
            {busy ? "Deleting…" : "Delete account"}
          </button>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
      </form>
    </section>
  );
}
