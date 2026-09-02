import { useRouterState, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useAccount } from "./dashboard-data";

export function SproutboatMark() {
  return (
    <svg className="sproutboat-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <path
        d="M10 23V9h7.3c3.3 0 5.4 1.8 5.4 4.7 0 3-2.1 4.8-5.4 4.8H14V23h-4Zm4-8h3c1.1 0 1.7-.5 1.7-1.3 0-.9-.6-1.4-1.7-1.4h-3V15Z"
        fill="white"
      />
    </svg>
  );
}

const NAV_ICON_PATHS = {
    overview: <><rect x="2.5" y="2.5" width="4" height="4" rx=".75" /><rect x="9.5" y="2.5" width="4" height="4" rx=".75" /><rect x="2.5" y="9.5" width="4" height="4" rx=".75" /><rect x="9.5" y="9.5" width="4" height="4" rx=".75" /></>,
    projects: <><path d="M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z" /><path d="M2.5 4.5v-1h4l1.2 1.5" /></>,
    deployments: <><path d="M8 2.5v7" /><path d="m5.5 7 2.5 2.5L10.5 7" /><path d="M3 11.5v2h10v-2" /></>,
    settings: <><circle cx="8" cy="8" r="2" /><path d="M8 2.5v1.2M8 12.3v1.2M2.5 8h1.2M12.3 8h1.2M4.1 4.1l.9.9M11 11l.9.9M11.9 4.1l-.9.9M5 11l-.9.9" /></>,
};
function NavIcon({ name }: { name: keyof typeof NAV_ICON_PATHS }) {
  return <svg className="nav-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">{NAV_ICON_PATHS[name]}</svg>;
}
export function Arrow() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path
        d="M3 8h9M8.5 3.5 13 8l-4.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

async function logout() {
  await fetch("/api/auth/sign-out", { method: "POST", credentials: "include" });
  location.assign("/login");
}

/** Last path segment as the topbar location: section names get a capital, a
 *  project slug is left as-is (it's a name, not a word). */
function topbarLabel(pathname: string): string {
  if (pathname === "/") return "Overview";
  const segment = pathname.split("/").filter(Boolean).pop() ?? "Overview";
  return /^[a-z]+$/.test(segment) ? segment[0].toUpperCase() + segment.slice(1) : segment;
}

function toggleTheme() {
  const theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("sproutboat-theme", theme);
}

export function Shell({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { account } = useAccount();
  const username = account?.profile?.username;
  const displayName = username || account?.user?.name || "account";
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" to="/">
          <SproutboatMark />
          <span>Sproutboat</span>
        </Link>
        <nav aria-label="Primary navigation">
          <span className="nav-section-label">Workspace</span>
          <Link
            className={
              pathname === "/" ? "nav-link active" : "nav-link"
            }
            to="/"
          >
            <NavIcon name="overview" />Overview
          </Link>
          <Link className={pathname === "/projects" ? "nav-link active" : "nav-link"} to="/projects">
            <NavIcon name="projects" />Projects
          </Link>
          <Link className={pathname === "/deployments" ? "nav-link active" : "nav-link"} to="/deployments"><NavIcon name="deployments" />Deployments</Link>
          <span className="nav-section-label nav-section-secondary">Account</span>
          <Link className={pathname === "/settings" ? "nav-link active" : "nav-link"} to="/settings"><NavIcon name="settings" />Settings</Link>
          {account?.isAdmin && (
            <Link className={pathname.startsWith("/admin") ? "nav-link active" : "nav-link"} to="/admin"><NavIcon name="settings" />Admin</Link>
          )}
        </nav>
        <div className="sidebar-bottom">
          <span className="status-dot" aria-hidden="true" />
          Experimental VPS POC
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <p><span>Personal account</span><b>/</b>{topbarLabel(pathname)}</p>
          <div className="topbar-actions">
            {account?.isAdmin && <span className="badge neutral">Admin</span>}
            <details className="account-menu">
              <summary aria-label="Open account menu" className="avatar"><Avatar image={account?.user?.image} label={displayName} /></summary>
              <div className="account-dropdown">
                {username ? <><strong>{username}</strong><Link to="/profile">Profile</Link><Link to="/settings">Settings</Link><button type="button" onClick={toggleTheme}>Toggle theme</button><button type="button" onClick={logout}>Log out</button></> : <><strong>Account</strong><Link to="/login">Sign in</Link></>}
              </div>
            </details>
          </div>
        </header>
        <main id="content">{children}</main>
        <footer className="app-footer"><span>Sproutboat experimental VPS platform</span><span>© {new Date().getFullYear()} Sproutboat</span><a href="mailto:hello@sproutboat.com">Contact</a></footer>
      </div>
    </div>
  );
}

/**
 * #1 danger-zone project deletion: a text trigger that expands into a
 * typed-name confirmation. The API needs `?confirm=<exact name>`, and the
 * Delete button stays disabled until the field matches. `onDeleted` is the
 * caller's list refresh — the row unmounts this component on success.
 */
export function DeleteProject({ name, onDeleted }: { name: string; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fieldId = `delete-project-${name}`;

  if (!open) {
    return <button type="button" className="text-button danger" onClick={() => setOpen(true)}>Delete…</button>;
  }

  const reset = () => { setOpen(false); setConfirm(""); setError(""); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(""); setBusy(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(name)}?confirm=${encodeURIComponent(confirm)}`, {
        method: "DELETE", credentials: "include",
      });
      if (!response.ok) {
        setBusy(false);
        setError(response.status === 404 ? "This project no longer exists — it may already be deleted." : "Could not delete this project. Try again.");
        return;
      }
      onDeleted();
    } catch {
      setBusy(false);
      setError("Could not reach the control plane. Try again.");
    }
  };

  return (
    <form className="danger-confirm" onSubmit={submit}>
      <label htmlFor={fieldId}>
        Type <strong>{name}</strong> to permanently delete this project, every deployed version, and its route. This cannot be undone.
      </label>
      <div className="danger-confirm-row">
        <input id={fieldId} value={confirm} autoComplete="off" spellCheck={false} placeholder={name}
          aria-invalid={error ? true : undefined} onChange={(event) => setConfirm(event.target.value)} />
        <button type="button" className="button quiet" onClick={reset} disabled={busy}>Cancel</button>
        <button type="submit" className="button danger" disabled={busy || confirm !== name}>
          {busy ? "Deleting…" : "Delete project"}
        </button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  );
}

/** #7: copy a full value (digests, hostnames) to the clipboard. */
export function Copy({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1200);
    } catch { /* clipboard blocked */ }
  };
  return <button type="button" className="copy-button" onClick={() => void copy()}>{done ? "Copied" : "Copy"}</button>;
}

/** #18: the GitHub avatar with the username initial as fallback when it is absent or fails to load. */
export function Avatar({ image, label }: { image?: string | null; label: string }) {
  const [failed, setFailed] = useState(false);
  if (image && !failed) {
    return <img className="avatar-img" src={image} alt={`${label} avatar`} width={32} height={32} onError={() => setFailed(true)} />;
  }
  return <span aria-hidden="true">{label.slice(0, 1).toUpperCase() || "?"}</span>;
}

export function Metric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "neutral" | "warning";
}) {
  return (
    <section className={`metric-card ${tone}`}>
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </section>
  );
}
