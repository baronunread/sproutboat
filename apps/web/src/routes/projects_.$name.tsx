import {
  Badge,
  Banner,
  Breadcrumbs,
  CopyId,
  EmptyState,
  PageHeader,
  PageTab,
  PageTabs,
  Skeleton,
  buttonStyles,
} from "@sproutboat/ikada";
import { createFileRoute, Link as RouterLink, Outlet, useRouterState } from "@tanstack/react-router";
import { useCallback } from "react";
import { ProjectProvider, useJson, useOverview, type ProjectDeployment } from "../dashboard-data";

export const Route = createFileRoute("/projects_/$name")({
  component: ProjectLayout,
  head: ({ params }) => ({ meta: [{ title: `${params.name} · Sproutboat` }] }),
});

const TABS = [
  { to: "/projects/$name", suffix: "", label: "Overview", exact: true },
  { to: "/projects/$name/deployments", suffix: "/deployments", label: "Deployments", exact: false },
  { to: "/projects/$name/metrics", suffix: "/metrics", label: "Metrics", exact: false },
  { to: "/projects/$name/logs", suffix: "/logs", label: "Logs", exact: false },
  { to: "/projects/$name/activity", suffix: "/activity", label: "Activity", exact: false },
  { to: "/projects/$name/bindings", suffix: "/bindings", label: "Bindings", exact: false },
  { to: "/projects/$name/triggers", suffix: "/triggers", label: "Triggers", exact: false },
  { to: "/projects/$name/settings", suffix: "/settings", label: "Settings", exact: false },
] as const;

function ProjectLayout() {
  const { name } = Route.useParams();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { data: overview, state, refresh: refreshOverview } = useOverview();
  // #76 - the project's own version list, so Deployments is complete and paged
  // here rather than cut to whatever fit in the account-wide overview.
  const versions = useJson<ProjectDeployment[]>(`/api/projects/${encodeURIComponent(name)}/deployments`);
  const deployments = versions.data ?? [];
  const active = overview?.projects.find((project) => project.name === name);
  const exists = deployments.length > 0;
  const loading = state === "loading" || versions.state === "loading";
  const failed = state === "error" || versions.state === "error";

  const refresh = useCallback(async () => {
    await Promise.all([refreshOverview(), versions.refresh()]);
  }, [refreshOverview, versions]);

  const base = `/projects/${encodeURIComponent(name)}`;
  const isCurrent = (tab: (typeof TABS)[number]) =>
    tab.exact
      ? pathname === base || pathname === `${base}/`
      : pathname === `${base}${tab.suffix}` || pathname.startsWith(`${base}${tab.suffix}/`);
  const showTabs = !loading && !failed && exists;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: "Sprouts", href: "/projects", render: <RouterLink to="/projects" /> },
              { label: name, id: "project" },
            ]}
          />
        }
        title={name}
        status={
          loading || !exists ? undefined : active ? (
            <Badge tone="success" dot live>
              Serving
            </Badge>
          ) : (
            <Badge tone="neutral">Not serving</Badge>
          )
        }
        description={
          loading ? (
            <Skeleton className="h-4 w-56" />
          ) : !exists ? undefined : active ? (
            <CopyId value={active.hostname} label="Copy route hostname" className="max-w-full" />
          ) : (
            "No active route: every version is inactive."
          )
        }
        actions={
          active ? (
            <a
              className={buttonStyles({ variant: "secondary" })}
              href={`https://${active.hostname}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open route
            </a>
          ) : undefined
        }
        tabs={
          showTabs ? (
            <PageTabs label="Project sections">
              {TABS.map((tab) => (
                <PageTab
                  key={tab.to}
                  current={isCurrent(tab)}
                  render={
                    <RouterLink to={tab.to} params={{ name }} activeOptions={tab.exact ? { exact: true } : undefined} />
                  }
                >
                  {tab.label}
                </PageTab>
              ))}
            </PageTabs>
          ) : undefined
        }
      />

      {loading ? (
        <div className="flex min-h-56 flex-col gap-3" aria-live="polite" aria-busy="true">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
          <span className="sr-only">Loading project…</span>
        </div>
      ) : failed ? (
        <Banner tone="danger">Could not load this project. Refresh and try again.</Banner>
      ) : !exists ? (
        <div className="rounded-xl bg-surface p-4 shadow-card">
          <EmptyState
            as="h2"
            title={`No project named ${name}`}
            description="It may have been deleted, or the URL is wrong."
            action={
              <RouterLink to="/projects" className={buttonStyles({ variant: "primary" })}>
                Back to sprouts
              </RouterLink>
            }
          />
        </div>
      ) : (
        <ProjectProvider value={{ name, deployments, active, refresh }}>
          <Outlet />
        </ProjectProvider>
      )}
    </div>
  );
}
