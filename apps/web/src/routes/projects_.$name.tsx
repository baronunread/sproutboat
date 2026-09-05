import { useCallback } from "react";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

import { ProjectProvider, useJson, useOverview, type ProjectDeployment } from "../dashboard-data";
import { buttonVariants } from "@/components/ui/button";
import { Panel, StatusMessage } from "../components";

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
    <>
      <section className="mb-8 flex items-center justify-between gap-8 border-b border-border pb-7 max-[800px]:mb-10 max-[800px]:flex-col max-[800px]:items-start [&_h1]:m-0 [&_h1]:text-[1.85rem] [&_h1]:font-bold [&_h1]:tracking-[-0.035em] [&_h1]:max-[480px]:text-[1.6rem] [&_p]:mt-1.5 [&_p]:max-w-[38rem] [&_p]:text-[0.875rem] [&_p]:leading-normal [&_p]:text-muted-foreground">
        <div>
          <p className="m-0 mb-2 text-[0.78rem] text-muted-foreground [&_a]:underline-offset-2 [&_a:hover]:underline [&>span]:mx-1.5"><Link to="/projects">Sprouts</Link> <span>/</span> {name}</p>
          <h1>{name}</h1>
          {!loading && (active
            ? <p>{active.hostname}</p>
            : <p>No active route — every version is superseded.</p>)}
        </div>
        {active && <a className={buttonVariants({ variant: "outline", className: "text-[0.82rem]" })} href={`https://${active.hostname}`}>Open route</a>}
      </section>

      {loading ? (
        <Panel variant="bare" className="min-h-56 px-5 pt-12 text-muted-foreground" aria-live="polite">Loading project…</Panel>
      ) : state === "error" || versions.state === "error" ? (
        <StatusMessage tone="error">Could not load this project. Refresh and try again.</StatusMessage>
      ) : !exists ? (
        <Panel variant="bare">
          <h2>No project named {name}</h2>
          <p>It may have been deleted, or the URL is wrong.</p>
          <Link className={buttonVariants({ variant: "default", className: "text-[0.82rem]" })} to="/projects">Back to projects</Link>
        </Panel>
      ) : (
        <>
          <nav className="mb-6 flex flex-wrap gap-1 border-b border-border" aria-label="Project sections">
            {TABS.map(([to, label, exact]) => (
              <Link key={to} to={to} params={{ name }} activeOptions={exact ? { exact: true } : undefined}
                activeProps={activeProps} className="-mb-px border-b-2 border-transparent px-3 py-2 text-[0.85rem] text-muted-foreground no-underline hover:text-foreground aria-[current=page]:border-brand aria-[current=page]:text-foreground">{label}</Link>
            ))}
          </nav>
          <ProjectProvider value={{ name, deployments, active, refresh }}>
            <Outlet />
          </ProjectProvider>
        </>
      )}
    </>
  );
}
