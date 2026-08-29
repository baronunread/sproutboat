import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { Shell } from "../components";
import { ProjectProvider, useOverview } from "../dashboard-data";

export const Route = createFileRoute("/projects_/$name")({
  component: ProjectLayout,
  head: ({ params }) => ({ meta: [{ title: `${params.name} · Sproutboat` }] }),
});

const activeProps = { "aria-current": "page" as const };

function ProjectLayout() {
  const { name } = Route.useParams();
  const { data, state, refresh } = useOverview();
  const deployments = data?.deployments.filter((deployment) => deployment.project === name) ?? [];
  const active = data?.projects.find((project) => project.name === name);
  const exists = deployments.length > 0;

  return (
    <Shell>
      <section className="page-heading">
        <div>
          <p className="crumb"><Link to="/projects">Projects</Link> <span>/</span> {name}</p>
          <h1>{name}</h1>
          {state === "ready" && (active
            ? <p>{active.hostname}</p>
            : <p>No active route — every version is superseded.</p>)}
        </div>
        {active && <a className="button quiet" href={`https://${active.hostname}`}>Open route</a>}
      </section>

      {state === "loading" ? (
        <section className="data-panel loading-state" aria-live="polite">Loading project…</section>
      ) : state === "error" ? (
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
            <Link to="/projects/$name" params={{ name }} activeOptions={{ exact: true }} activeProps={activeProps} className="section-tab">Overview</Link>
            <Link to="/projects/$name/deployments" params={{ name }} activeProps={activeProps} className="section-tab">Deployments</Link>
            <Link to="/projects/$name/observability" params={{ name }} activeProps={activeProps} className="section-tab">Observability</Link>
            <Link to="/projects/$name/settings" params={{ name }} activeProps={activeProps} className="section-tab">Settings</Link>
          </nav>
          <ProjectProvider value={{ name, deployments, active, refresh }}>
            <Outlet />
          </ProjectProvider>
        </>
      )}
    </Shell>
  );
}
