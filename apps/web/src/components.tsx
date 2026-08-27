import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";

export function PorfferMark() {
  return <svg className="porffer-mark" viewBox="0 0 32 32" aria-label="Porffer" role="img"><rect width="32" height="32" rx="8" fill="currentColor" /><path d="M10 23V9h7.3c3.3 0 5.4 1.8 5.4 4.7 0 3-2.1 4.8-5.4 4.8H14V23h-4Zm4-8h3c1.1 0 1.7-.5 1.7-1.3 0-.9-.6-1.4-1.7-1.4h-3V15Z" fill="white" /></svg>;
}

export function Shell({ children, isOperator = false }: { children: ReactNode; isOperator?: boolean }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return <div className="app-shell">
    <aside className="sidebar" aria-label="Primary navigation">
      <Link className="brand" to="/dashboard"><PorfferMark /><span>Porffer</span></Link>
      <p className="workspace-label">Workspace</p>
      <nav><Link className={pathname === "/dashboard" ? "nav-link active" : "nav-link"} to="/dashboard">Overview</Link><a className="nav-link" href="#projects">Projects</a><a className="nav-link" href="#deployments">Deployments</a><a className="nav-link" href="#logs">Logs</a>{isOperator && <><p className="workspace-label">Platform</p><a className="nav-link" href="#platform">Platform</a><a className="nav-link" href="#users">Users</a><a className="nav-link" href="#infrastructure">Infrastructure</a></>}</nav>
      <div className="sidebar-bottom"><span className="status-dot" /> <span>Experimental platform</span></div>
    </aside>
    <div className="main-column"><header className="topbar"><div><p className="mono-label">Dashboard</p></div><div className="topbar-actions">{isOperator && <span className="badge neutral">Operator</span>}<button className="avatar" aria-label="Account menu">A</button></div></header><main id="content">{children}</main></div>
  </div>;
}

export function Metric({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: "neutral" | "good" | "purple" | "warning" }) {
  return <section className={`metric-card ${tone}`}><p>{label}</p><strong>{value}</strong><span>{detail}</span></section>;
}

export function EmptyChart({ label, note }: { label: string; note: string }) {
  const headingId = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-heading`;
  return <section className="panel chart-panel" aria-labelledby={headingId}><div className="panel-heading"><div><p className="mono-label">{label}</p><h2 id={headingId}>{note}</h2></div><button className="button ghost" type="button">Last 24 hours</button></div><div className="chart-empty"><div className="grid-lines" /><p>Metrics appear after the first routed request.</p></div></section>;
}
