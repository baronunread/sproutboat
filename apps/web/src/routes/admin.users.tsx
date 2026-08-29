import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { relativeTime } from "../dashboard-data";

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
    <section className="data-panel settings-panel">
      <div className="panel-heading">
        <div><h2>Users</h2><p>Every account. Banning an account stops its routes immediately.</p></div>
      </div>

      <div className="log-filters">
        <input aria-label="Search users by email" placeholder="Search email" value={query}
          onChange={(event) => { setOffset(0); setQuery(event.target.value); }} />
      </div>
      {note && <p className="form-status" role="status">{note}</p>}

      {state === "loading" ? (
        <p className="loading-state" aria-live="polite">Loading users…</p>
      ) : state === "error" || !page ? (
        <p className="form-error" role="alert">Could not load users. Refresh and try again.</p>
      ) : page.users.length === 0 ? (
        <p className="empty-state">No accounts match.</p>
      ) : (
        <>
          <ul className="user-list">
            {page.users.map((user) => (
              <UserItem key={user.id} user={user} onAct={act} />
            ))}
          </ul>
          <div className="pager">
            <button type="button" className="button quiet" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
            <span>{offset + 1}–{Math.min(offset + page.users.length, page.total)} of {page.total}</span>
            <button type="button" className="button quiet" disabled={offset + PAGE >= page.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
          </div>
        </>
      )}
    </section>
  );
}

function UserItem({ user, onAct }: { user: UserRow; onAct: (id: string, path: string, body?: ActionBody) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [banning, setBanning] = useState(false);
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
    await onAct(user.id, "ban", { reason: reason.trim() || undefined, expiresIn: duration || undefined });
    setBanning(false); setReason("");
  };

  return (
    <li className="user-item">
      <div className="user-row">
        <button type="button" className="record-title" onClick={() => setOpen((value) => !value)}>{user.email}</button>
        <small>{user.name ?? "—"} · {user.role} · joined {relativeTime(user.createdAt)}</small>
        <span>{user.projects} proj · {user.deployments} dep</span>
        <b className={user.banned ? "status" : "status live"}>{user.banned ? "Banned" : "Active"}</b>
        {user.banned
          ? <button type="button" className="button quiet" onClick={() => void onAct(user.id, "unban")}>Unban</button>
          : <button type="button" className="text-button danger" onClick={() => setBanning((value) => !value)}>Ban…</button>}
      </div>

      {user.banned && user.banReason && <p className="hint">Reason: {user.banReason}{user.banExpires ? ` · lifts ${relativeTime(user.banExpires)}` : " · permanent"}</p>}

      {banning && (
        <div className="ban-form">
          <input aria-label="Ban reason" placeholder="Reason (optional)" value={reason} onChange={(event) => setReason(event.target.value)} />
          <select aria-label="Ban duration" value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
            {DURATIONS.map(([label, seconds]) => <option key={label} value={seconds}>{label}</option>)}
          </select>
          <button type="button" className="button quiet" onClick={() => setBanning(false)}>Cancel</button>
          <button type="button" className="button danger" onClick={() => void submitBan()}>Ban account</button>
        </div>
      )}

      {open && (
        <div className="user-detail">
          {detailState === "loading" || detailState === "idle" ? (
            <p className="loading-state" aria-live="polite">Loading…</p>
          ) : detailState === "error" || !detail ? (
            <p className="form-error" role="alert">Could not load this account.</p>
          ) : (
            <>
              <h4>Deployments ({detail.deployments.length})</h4>
              {detail.deployments.length === 0 ? <p className="hint">None.</p> : (
                <ul className="record-list">
                  {detail.deployments.map((deployment) => (
                    <li key={deployment.id}>
                      <div><strong>{deployment.project}</strong><small>{deployment.hostname}</small></div>
                      <span>{relativeTime(deployment.deployedAt)}</span>
                      <b className={deployment.active ? "status live" : "status"}>{deployment.active ? "Active" : "Superseded"}</b>
                    </li>
                  ))}
                </ul>
              )}
              <h4>Sessions ({detail.sessions.length})</h4>
              {detail.sessions.length === 0 ? <p className="hint">None.</p> : (
                <ul className="session-list">
                  {detail.sessions.map((session) => (
                    <li key={session.id}><span>{session.ipAddress ?? "unknown IP"}</span><small>expires {relativeTime(session.expiresAt)}</small></li>
                  ))}
                </ul>
              )}
              <button type="button" className="button quiet" onClick={() => void onAct(user.id, "sessions/revoke")}>Revoke all sessions</button>
            </>
          )}
        </div>
      )}
    </li>
  );
}
