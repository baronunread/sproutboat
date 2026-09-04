import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button, Copy, Panel, PanelHeading, RECORD_TITLE, RecordList, RecordRow, SelectField, Status, StatusMessage, TextField } from "../components";
import { USERNAME_RULE, relativeTime } from "../dashboard-data";

export const Route = createFileRoute("/admin/users")({ component: AdminUsers });

type UserRow = {
  id: string; email: string; name: string | null; image: string | null;
  role: string; banned: boolean; banReason: string | null; banExpires: string | null;
  createdAt: string; projects: number; deployments: number; activeProjects: number;
};
type UsersPage = { users: UserRow[]; total: number; limit: number; offset: number };

type Deployment = { id: string; project: string; hostname: string; artifact: string; deployedAt: string; active: boolean };
type Session = { id: string; createdAt: string; expiresAt: string; ipAddress: string | null; userAgent: string | null };
type Detail = { user: UserRow; deployments: Deployment[]; sessions: Session[] };
type ActionBody = { reason?: string; expiresIn?: number };

const PAGE = 50;
const DURATIONS: ReadonlyArray<readonly [string, number]> = [
  ["Permanent", 0], ["1 day", 86_400], ["7 days", 604_800], ["30 days", 2_592_000],
];

function AdminUsers() {
  const [page, setPage] = useState<UsersPage>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [note, setNote] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setState("loading");
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (query.trim()) params.set("q", query.trim());
    try {
      const response = await fetch(`/api/admin/users?${params.toString()}`, { credentials: "include" });
      if (!response.ok) { setState("error"); return; }
      // SAFETY: a 2xx from /api/admin/users is the UsersPage contract.
      setPage(await response.json() as UsersPage);
      setState("ready");
    } catch { setState("error"); }
  }, [offset, query]);
  useEffect(() => { void load(); }, [load]);

  const act = async (id: string, path: string, body?: ActionBody) => {
    setNote("");
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(id)}/${path}`, {
        method: "POST", credentials: "include",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) { setNote("That action failed. Refresh and try again."); return; }
      await load();
    } catch { setNote("Could not reach the control plane. Try again."); }
  };

  return (
    <Panel variant="wide">
      <PanelHeading
        title="Users"
        description="Accounts are created here — there is no self-service sign-up. Banning an account stops its routes immediately."
        action={!creating && <Button variant="primary" onClick={() => setCreating(true)}>Create user</Button>}
      />

      {creating && <CreateUserForm onCreated={() => void load()} onClose={() => setCreating(false)} />}

      <div className="mt-5 mb-3 flex flex-wrap items-end gap-2.5">
        <TextField label="Search users" type="search" fieldClassName="min-w-0 flex-[1_1_16rem]" placeholder="Search by email"
          value={query} onChange={(event) => { setOffset(0); setQuery(event.target.value); }} />
      </div>
      {note && <StatusMessage tone="error">{note}</StatusMessage>}

      {state === "loading" ? (
        <p className="min-h-56 px-5 pt-12 text-muted-foreground group-[.is-padded]/panel:px-0" aria-live="polite">Loading users…</p>
      ) : state === "error" || !page ? (
        <StatusMessage tone="error">Could not load users. Refresh and try again.</StatusMessage>
      ) : page.users.length === 0 ? (
        <p className="px-5 py-12 text-center text-[0.84rem] leading-relaxed text-muted-foreground group-[.is-padded]/panel:px-0 group-[.is-padded]/panel:py-5 group-[.is-padded]/panel:text-start [&_code]:text-foreground">No accounts match.</p>
      ) : (
        <>
          <ul className="m-0 mt-4 list-none p-0" aria-label="User accounts">
            {page.users.map((user) => (
              <UserItem key={user.id} user={user} onAct={act} />
            ))}
          </ul>
          <div className="mt-4 flex items-center justify-center gap-4 text-[0.78rem] text-muted-foreground">
            <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
            <span>{offset + 1}–{Math.min(offset + page.users.length, page.total)} of {page.total}</span>
            <Button disabled={offset + PAGE >= page.total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
          </div>
        </>
      )}
    </Panel>
  );
}

function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "").slice(0, 20);
}

function CreateUserForm({ onCreated, onClose }: { onCreated: () => void; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ email: string; username: string; password: string } | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), username: username.trim(), password }),
      });
      if (!response.ok) {
        // SAFETY: an error body from this endpoint is { error: string }.
        const body = await response.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? "Could not create the user.");
        return;
      }
      setDone({ email: email.trim(), username: username.trim(), password });
      setEmail(""); setUsername(""); setPassword("");
      onCreated();
    } catch { setError("Could not reach the control plane."); }
    finally { setBusy(false); }
  };

  if (done) {
    return (
      <StatusMessage tone="success">
        Created <code>{done.username}</code> ({done.email}). Starting password: <code>{done.password}</code>
        <Copy value={done.password} /> — copy it now, it isn&apos;t shown again.
      </StatusMessage>
    );
  }

  return (
    <form onSubmit={submit}>
      <div className="mt-5 grid max-w-[46rem] grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-5 [&>[data-slot=form-actions]]:col-span-full">
        <TextField
          label="Email"
          type="email"
          autoComplete="off"
          required
          value={email}
          onChange={(event) => { setEmail(event.target.value); setError(""); }}
          hint="The address they sign in with, or link GitHub to."
        />
        <TextField
          label="Namespace"
          required
          autoComplete="off"
          spellCheck={false}
          value={username}
          onChange={(event) => { setUsername(event.target.value.toLowerCase()); setError(""); }}
          hint="3–32 lowercase letters, digits and hyphens. It appears in every route they deploy."
          error={username !== "" && !USERNAME_RULE.test(username)
            ? "Use 3–32 lowercase letters, digits or hyphens." : null}
        />
        <TextField
          label="Starting password"
          type="text"
          autoComplete="off"
          spellCheck={false}
          required
          minLength={10}
          value={password}
          onChange={(event) => { setPassword(event.target.value); setError(""); }}
          hint="At least 10 characters. Shown once, here, so hand it over before you close this form."
          error={password !== "" && password.length < 10 ? "Use at least 10 characters." : error || null}
          footer={<Button variant="quiet" onClick={() => setPassword(randomPassword())}>Generate a password</Button>}
        />
      </div>
      <div data-slot="form-actions" className="mt-1 flex flex-wrap items-center gap-2.5">
        <Button variant="quiet" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" busy={busy} busyLabel="Creating…" disabled={!email || !username || password.length < 10}>Create account</Button>
      </div>
    </form>
  );
}

function UserItem({ user, onAct }: { user: UserRow; onAct: (id: string, path: string, body?: ActionBody) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [banning, setBanning] = useState(false);
  const [banBusy, setBanBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState(0);
  const [detail, setDetail] = useState<Detail>();
  const [detailState, setDetailState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    if (!open || detailState !== "idle") return;
    let ignore = false;
    const load = async () => {
      setDetailState("loading");
      try {
        const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, { credentials: "include" });
        if (ignore) return;
        if (!response.ok) { setDetailState("error"); return; }
        // SAFETY: a 2xx from /api/admin/users/:id is the Detail contract.
        const body = await response.json() as Detail;
        if (ignore) return;
        setDetail(body); setDetailState("ready");
      } catch { if (!ignore) setDetailState("error"); }
    };
    void load();
    return () => { ignore = true; };
  }, [open, detailState, user.id]);

  const submitBan = async () => {
    setBanBusy(true);
    try {
      await onAct(user.id, "ban", { reason: reason.trim() || undefined, expiresIn: duration || undefined });
    } finally {
      setBanBusy(false);
    }
    setBanning(false); setReason("");
  };

  return (
    <li className="border-t border-border py-3 first:border-t-0 hover:bg-accent">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 [&>button:first-child]:min-w-0 [&>button:first-child]:flex-[1_1_14rem] [&>button:not(:first-child)]:flex-none [&>small]:order-9 [&>small]:-mt-1 [&>small]:basis-full [&>small]:text-[0.72rem] [&>small]:text-muted-foreground [&>span]:flex-none [&>span]:text-[0.72rem] [&>span]:text-muted-foreground">
        <button type="button" className={RECORD_TITLE} aria-expanded={open} onClick={() => setOpen((value) => !value)}>{user.email}</button>
        <small>{user.name ?? "—"} · {user.role} · joined {relativeTime(user.createdAt)}</small>
        <span>{user.projects} proj · {user.deployments} dep</span>
        <Status live={!(user.banned)}>{user.banned ? "Banned" : "Active"}</Status>
        {user.banned
          ? <Button onClick={() => void onAct(user.id, "unban")}>Unban</Button>
          : <Button aria-expanded={banning} onClick={() => setBanning((value) => !value)}>Ban</Button>}
      </div>

      {user.banned && user.banReason && <p className="mt-3 text-[0.75rem] text-muted-foreground">Reason: {user.banReason}{user.banExpires ? ` · lifts ${relativeTime(user.banExpires)}` : " · permanent"}</p>}

      {banning && (
        <div className="mt-3 flex flex-wrap items-end gap-2.5">
          <TextField label="Ban reason" fieldClassName="min-w-0 flex-[1_1_16rem]" placeholder="Optional — shown in the users list"
            value={reason} onChange={(event) => setReason(event.target.value)} />
          <SelectField label="Duration" value={String(duration)}
            options={DURATIONS.map(([label, seconds]) => [String(seconds), label] as const)}
            onValueChange={(value) => setDuration(Number(value))} />
          <Button onClick={() => setBanning(false)}>Cancel</Button>
          <Button variant="danger" busy={banBusy} busyLabel="Banning…" onClick={() => void submitBan()}>Ban account</Button>
        </div>
      )}

      {open && (
        <div className="mt-3 border-l-2 border-border pl-4 [&_h4]:mt-4 [&_h4]:mb-1.5 [&_h4]:text-[0.78rem] [&_h4:first-child]:mt-0">
          {detailState === "loading" || detailState === "idle" ? (
            <p className="min-h-56 px-5 pt-12 text-muted-foreground group-[.is-padded]/panel:px-0" aria-live="polite">Loading…</p>
          ) : detailState === "error" || !detail ? (
            <StatusMessage tone="error">Could not load this account.</StatusMessage>
          ) : (
            <>
              <h4>Deployments ({detail.deployments.length})</h4>
              {detail.deployments.length === 0 ? <p className="mt-3 text-[0.75rem] text-muted-foreground">None.</p> : (
                <RecordList>
                  {detail.deployments.map((deployment) => (
                    <RecordRow key={deployment.id}>
                      <div><strong>{deployment.project}</strong><small>{deployment.hostname}</small></div>
                      <span>{relativeTime(deployment.deployedAt)}</span>
                      <Status live={deployment.active}>{deployment.active ? "Active" : "Superseded"}</Status>
                    </RecordRow>
                  ))}
                </RecordList>
              )}
              <h4>Sessions ({detail.sessions.length})</h4>
              {detail.sessions.length === 0 ? <p className="mt-3 text-[0.75rem] text-muted-foreground">None.</p> : (
                <ul className="m-0 list-none p-0 [&_li]:flex [&_li]:justify-between [&_li]:gap-3 [&_li]:border-t [&_li]:border-border [&_li]:py-1.5 [&_small]:text-muted-foreground">
                  {detail.sessions.map((session) => (
                    <li key={session.id}><span>{session.ipAddress ?? "unknown IP"}</span><small>expires {relativeTime(session.expiresAt)}</small></li>
                  ))}
                </ul>
              )}
              <div data-slot="form-actions" className="mt-1 flex flex-wrap items-center gap-2.5">
                <Button onClick={() => void onAct(user.id, "sessions/revoke")}>Revoke all sessions</Button>
              </div>
            </>
          )}
        </div>
      )}
    </li>
  );
}
