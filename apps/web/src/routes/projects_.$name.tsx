import { useCallback } from "react";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { Shell } from "../components";
import { ProjectProvider, useJson, useOverview, type ProjectDeployment } from "../dashboard-data";

export const Route = createFileRoute("/projects_/$name")({
  component: ProjectLayout,
  head: ({ params }) => ({ meta: [{ title: `${params.name} · Sproutboat` }] }),
});

const activeProps = { "aria-current": "page" as const };

const TABS = [
  ["/projects/$name", "Overview", true],
  ["/projects/$name/metrics", "Metrics", false],
  ["/projects/$name/logs", "Logs", false],
  ["/projects/$name/deployments", "Deployments", false],
  ["/projects/$name/bindings", "Bindings", false],
  ["/projects/$name/triggers", "Triggers", false],
  ["/projects/$name/settings", "Settings", false],
] as const;

function ProjectLayout() {
  const { name } = Route.useParams();
  const { data: overview, state, refresh: refreshOverview } = useOverview();
  // #76 — the project's own version list, so Deployments is complete and paged
  // here rather than cut to whatever fit in the account-wide overview.
  const versions = useJson<ProjectDeployment[]>(`/api/projects/${encodeURIComponent(name)}/deployments`);
  const deployments = versions.data ?? [];
  const active = overview?.projects.find((project) => project.name === name);
  const exists = deployments.length > 0;
  const loading = state === "loading" || versions.state === "loading";

  const refresh = useCallback(async () => {
    await Promise.all([refreshOverview(), versions.refresh()]);
  }, [refreshOverview, versions]);

  return (
    <Shell>
      <section className="page-heading">
        <div>
          <p className="crumb"><Link to="/projects">Projects</Link> <span>/</span> {name}</p>
          <h1>{name}</h1>
          {!loading && (active
            ? <p>{active.hostname}</p>
            : <p>No active route — every version is superseded.</p>)}
        </div>
        {active && <a className="button quiet" href={`https://${active.hostname}`}>Open route</a>}
      </section>

      {loading ? (
        <section className="data-panel loading-state" aria-live="polite">Loading project…</section>
      ) : state === "error" || versions.state === "error" ? (
        <p className="form-error" role="alert">Could not load this project. Refresh and try again.</p>
      ) : !exists ? (
        <section className="data-panel empty-state">
          <h2>No project named {name}</h2>
          <p>It may have been deleted, or the URL is wrong.</p>
          <Link className="button primary" to="/projects">Back to projects</Link>
        </section>
      ) : (
        <>
          <nav className="section-nav" aria-label="Project sections">
            {TABS.map(([to, label, exact]) => (
              <Link key={to} to={to} params={{ name }} activeOptions={exact ? { exact: true } : undefined}
                activeProps={activeProps} className="section-tab">{label}</Link>
            ))}
          </nav>
          <ProjectProvider value={{ name, deployments, active, refresh }}>
            <Outlet />
          </ProjectProvider>
        </>
      )}
    </Shell>
  );
}
