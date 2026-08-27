import { useEffect, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";

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

function NavIcon({ name }: { name: "overview" | "projects" | "deployments" | "settings" }) {
  const paths = {
    overview: <><rect x="2.5" y="2.5" width="4" height="4" rx=".75" /><rect x="9.5" y="2.5" width="4" height="4" rx=".75" /><rect x="2.5" y="9.5" width="4" height="4" rx=".75" /><rect x="9.5" y="9.5" width="4" height="4" rx=".75" /></>,
    projects: <><path d="M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z" /><path d="M2.5 4.5v-1h4l1.2 1.5" /></>,
    deployments: <><path d="M8 2.5v7" /><path d="m5.5 7 2.5 2.5L10.5 7" /><path d="M3 11.5v2h10v-2" /></>,
    settings: <><circle cx="8" cy="8" r="2" /><path d="M8 2.5v1.2M8 12.3v1.2M2.5 8h1.2M12.3 8h1.2M4.1 4.1l.9.9M11 11l.9.9M11.9 4.1l-.9.9M5 11l-.9.9" /></>,
  };
  return <svg className="nav-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
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

export function Shell({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const [account, setAccount] = useState<{ profile?: { username?: string }; isOperator?: boolean }>();
  useEffect(() => { void fetch("/v1/me", { credentials: "include" }).then((response) => response.ok ? response.json() : undefined).then(setAccount).catch(() => undefined); }, []);
  const username = account?.profile?.username;
  const logout = async () => {
    await fetch("/api/auth/sign-out", { method: "POST", credentials: "include" });
    location.assign("/login");
  };
  const toggleTheme = () => {
    const theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("sproutboat-theme", theme);
  };
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
        </nav>
        <div className="sidebar-bottom">
          <span className="status-dot" aria-hidden="true" />
          Experimental VPS POC
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <p><span>Personal account</span><b>/</b>{pathname === "/" ? "Overview" : pathname.slice(1)}</p>
          <div className="topbar-actions">
            {account?.isOperator && <span className="badge neutral">Operator</span>}
            <details className="account-menu">
              <summary aria-label="Open account menu" className="avatar">{username?.slice(0, 1).toUpperCase() || "?"}</summary>
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

export function Metric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "neutral" | "good" | "purple" | "warning";
}) {
  return (
    <section className={`metric-card ${tone}`}>
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </section>
  );
}
export function EmptyChart({ label, note }: { label: string; note: string }) {
  const headingId = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-heading`;
  return (
    <section className="activity-panel" aria-labelledby={headingId}>
      <div className="panel-heading">
        <div>
          <h2 id={headingId}>{note}</h2>
        </div>
        <span className="period-label">24 hours</span>
      </div>
      <div className="chart-empty">
        <div className="signal-line" />
        <p>Traffic will appear here after your first routed request.</p>
      </div>
    </section>
  );
}
