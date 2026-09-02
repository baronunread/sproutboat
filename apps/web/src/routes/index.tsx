import { createFileRoute, Link } from "@tanstack/react-router";
import { Arrow, Metric, Shell } from "../components";
import { relativeTime, useOverview } from "../dashboard-data";

// __root.tsx's AuthGate redirects anon visitors to /login once the session
// check resolves; useOverview also has its own sign-in state as a fallback.
export const Route = createFileRoute("/")({
  component: Overview,
  head: () => ({ meta: [{ title: "Sproutboat" }] }),
});

function Overview() {
  const { data, state } = useOverview();
  const metrics = data?.metrics;
  const cliCode = import.meta.env.SSR ? null : new URLSearchParams(location.search).get("cli_code");
  const approve = async () => {
    if (!cliCode) return;
    const response = await fetch(`/api/cli/authorizations/${encodeURIComponent(cliCode)}/approve`, { method: "POST", credentials: "include" });
    if (response.ok) history.replaceState({}, "", "/");
  };
  return <Shell><section className="page-heading"><div><h1>Your deployments, at a glance.</h1><p>Live information from your active routes and deployment history.</p></div><Link className="button primary" to="/deployments">View deployments</Link></section>
    {cliCode && <section className="connection-banner"><div><h2>Connect this machine to Sproutboat.</h2><p>{data ? "Approve this browser login to store a local CLI credential." : "Sign in and claim a namespace before approving this browser login."}</p></div>{data ? <button className="button primary" type="button" onClick={approve}>Approve login <Arrow /></button> : <Link className="button primary" to={state === "sign-in" ? "/login" : "/profile"}>Continue <Arrow /></Link>}</section>}
    {state === "loading" ? <section className="data-panel loading-state" aria-live="polite">Loading workspace data…</section> : state === "sign-in" ? <section className="data-panel empty-state"><h2>Sign in to view your workspace</h2><p>Sign in to deploy and inspect your services.</p><Link className="button primary" to="/login">Sign in</Link></section> : state === "setup" ? <section className="data-panel empty-state"><h2>Claim your deployment namespace</h2><p>Set up the namespace that will be used in your project routes.</p><Link className="button primary" to="/profile">Set up profile</Link></section> : state === "error" ? <p className="form-error" role="alert">Could not load workspace data. Refresh and try again.</p> : <>
      <AccountTrend trend={metrics?.trend ?? []} requests={metrics?.requestsLast24Hours ?? 0} />
      <section className="metrics" aria-label="Deployment statistics"><Metric label="Active projects" value={metrics ? String(metrics.activeProjects) : "—"} detail="Routes currently serving" /><Metric label="Deployments" value={metrics ? String(metrics.deployments) : "—"} detail="Immutable versions" /><Metric label="Requests" value={metrics ? String(metrics.requestsLast24Hours) : "—"} detail="Last 24 hours" /><Metric label="Success rate" value={metrics ? metrics.successRate === null ? "—" : `${metrics.successRate}%` : "—"} detail={metrics?.successRate === null ? "No requests yet" : "Last 24 hours"} /></section>
      <section className="data-panel"><div className="panel-heading"><div><h2>Recent deployments</h2><p>The latest versions from your account.</p></div><Link to="/deployments">All deployments</Link></div>{data?.deployments.length ? <ul className="record-list">{data.deployments.slice(0, 5).map((deployment) => <li key={deployment.id}><div><strong>{deployment.project}</strong><small>Deployment {deployment.id.slice(0, 8)} · {deployment.hostname}</small></div><code title={`Artifact ${deployment.artifact}`}>Artifact {deployment.artifact.slice(0, 12)}</code><span>{relativeTime(deployment.deployedAt)}</span><b className={deployment.active ? "status live" : "status"}>{deployment.active ? "Active" : "Superseded"}</b></li>)}</ul> : <EmptyDeployment />}</section>
    </>}
  </Shell>;
}

/**
 * #76 — the account-wide traffic trend Cloudflare puts on its Workers home:
 * 24 hourly buckets across every route this account owns, from the same scan
 * that produces the request/success metrics.
 */
function AccountTrend({ trend, requests }: { trend: Array<{ start: string; count: number; errors: number }>; requests: number }) {
  if (trend.length === 0 || requests === 0) return null;
  const max = Math.max(1, ...trend.map((bucket) => bucket.count));
  const step = 100 / trend.length;
  const hour = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
  return (
    <section className="data-panel settings-panel account-trend">
      <div className="panel-heading">
        <div><h2>Traffic</h2><p>Requests across every route on this account, last 24 hours.</p></div>
      </div>
      <svg className="bars" viewBox="0 0 100 28" preserveAspectRatio="none" role="img"
        aria-label={`Requests per hour across all routes, peak ${max} in one bucket`}>
        {trend.map((bucket, index) => {
          const height = (bucket.count / max) * 26;
          const errorHeight = (bucket.errors / max) * 26;
          return (
            <g key={bucket.start}>
              <title>{`${hour.format(new Date(bucket.start))} — ${bucket.count} request${bucket.count === 1 ? "" : "s"}, ${bucket.errors} error${bucket.errors === 1 ? "" : "s"}`}</title>
              <rect x={index * step} y={26 - height} width={step - 0.6} height={height} fill="var(--muted)" />
              {errorHeight > 0 && <rect x={index * step} y={26 - errorHeight} width={step - 0.6} height={errorHeight} fill="var(--coral)" />}
            </g>
          );
        })}
      </svg>
      <div className="bars-axis">
        <span>{hour.format(new Date(trend[0].start))}</span>
        <span>now</span>
      </div>
    </section>
  );
}

export function EmptyDeployment() { return <div className="empty-state"><h2>Deploy your first service</h2><p>Deploy from a project directory and its active route, version history, and traffic will appear here.</p><code>sproutboat deploy hello</code></div>; }
