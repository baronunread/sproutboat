import { useState, type FormEvent } from "react";
import { Button, ConfirmButton, Panel, PanelHeading, StatusMessage, TextField } from "./components";
import { mutate, relativeTime, useJson } from "./dashboard-data";

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
  const { data, state, refresh } = useJson<{ credentials: Credential[] }>("/api/account/credentials");
  const [note, setNote] = useState<{ text: string; tone: "success" | "error" } | null>(null);
  const items = data?.credentials ?? [];

  const revoke = async (id: string, label: string) => {
    const failure = await mutate(`/api/account/credentials/${encodeURIComponent(id)}`, { method: "DELETE" });
    setNote({ text: failure ?? `Revoked “${label}”.`, tone: failure ? "error" : "success" });
    await refresh();
  };

  const revokeAll = async () => {
    const response = await fetch("/api/account/credentials", { method: "DELETE", credentials: "include" }).catch(() => null);
    if (!response?.ok) { setNote({ text: "Could not revoke the credentials. Try again.", tone: "error" }); return; }
    // SAFETY: a 2xx from the revoke-all endpoint is { revoked: number }.
    const body = await response.json() as { revoked: number };
    setNote({ text: `Revoked ${body.revoked} credential${body.revoked === 1 ? "" : "s"}.`, tone: "success" });
    await refresh();
  };

  return (
    <Panel variant="wide">
      <PanelHeading
        title="API tokens"
        description={<>Keys created by <code>sproutboat login</code>. Your browser session is separate and stays signed in.</>}
        action={state === "ready" && items.length > 0 ? (
          <ConfirmButton
            label="Revoke all"
            busyLabel="Revoking…"
            title="Revoke every API token?"
            description={<>Every machine using one must run <code>sproutboat login</code> again. Your browser session is unaffected.</>}
            confirmLabel="Revoke all tokens"
            onConfirm={revokeAll}
          />
        ) : undefined}
      />
      {note && <StatusMessage tone={note.tone}>{note.text}</StatusMessage>}
      {state === "loading" ? (
        <p className="min-h-56 px-5 pt-12 text-muted-foreground group-[.is-padded]/panel:px-0" aria-live="polite">Loading tokens…</p>
      ) : state === "error" ? (
        <StatusMessage tone="error">Could not load tokens. Refresh and try again.</StatusMessage>
      ) : items.length === 0 ? (
        <p className="px-5 py-12 text-center text-[0.84rem] leading-relaxed text-muted-foreground group-[.is-padded]/panel:px-0 group-[.is-padded]/panel:py-5 group-[.is-padded]/panel:text-start [&_code]:text-foreground">No API tokens yet. Run <code>sproutboat login</code> on a machine to create one.</p>
      ) : (
        <ul className="m-0 mt-4 list-none p-0 [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:gap-x-4 [&>li]:gap-y-2 [&>li]:border-t [&>li]:border-border [&>li]:py-3.5 [&>li:first-child]:border-t-0 [&>li>*]:flex-none [&>li>:first-child]:min-w-0 [&>li>:first-child]:flex-[1_1_14rem] [&_small]:mt-1 [&_small]:block [&_small]:text-[0.74rem] [&_small]:text-muted-foreground [&_span]:text-[0.74rem] [&_span]:text-muted-foreground [&_strong]:block [&_strong]:text-[0.85rem] [&_strong]:font-medium" aria-label="API tokens">
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
                <ConfirmButton
                  label="Revoke"
                  busyLabel="Revoking…"
                  triggerVariant="quiet"
                  title={`Revoke “${label}”?`}
                  description={<>Any machine using this token must run <code>sproutboat login</code> again. This takes effect immediately.</>}
                  confirmLabel="Revoke token"
                  onConfirm={() => revoke(credential.id, label)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
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
  const mismatch = confirm !== "" && confirm !== expected;

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
    <Panel className="[&_h2]:text-destructive">
      <PanelHeading
        title="Delete account"
        description="This permanently removes your namespace, every project and deployment, all routed hostnames, and every issued API token. Active routes stop serving immediately and you are signed out. This cannot be undone."
      />
      <form className="mt-5 grid max-w-[36rem] gap-5 [&>[data-slot=form-actions]]:col-span-full" onSubmit={submit}>
        <TextField
          label={`Type ${expected || "your username"} to confirm`}
          value={confirm}
          onChange={(event) => { setConfirm(event.target.value); setError(""); }}
          autoComplete="off"
          spellCheck={false}
          placeholder={expected}
          disabled={!expected}
          error={mismatch ? "That does not match your username." : error || null}
        />
        <div data-slot="form-actions" className="mt-1 flex flex-wrap items-center gap-2.5">
          <Button type="submit" variant="danger" busy={busy} busyLabel="Deleting…" disabled={!expected || confirm !== expected}>
            Delete account
          </Button>
        </div>
      </form>
    </Panel>
  );
}
