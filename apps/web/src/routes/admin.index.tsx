import { MetricTile, UsageMeter } from "@sproutboat/ikada";
import { createFileRoute } from "@tanstack/react-router";
import { useJson } from "../dashboard-data";
import { LoadError, LoadingBlock, Section } from "../page-state";

export const Route = createFileRoute("/admin/")({ component: AdminSystem });

type Runtime = {
  live: number;
  spawns: number;
  restarts: number;
  readyFailures: number;
  idleEvictions: number;
  portsInUse: number;
  portPoolSize: number;
};
type SystemOverview = {
  owners: number;
  projects: number;
  activeProjects: number;
  deployments: number;
  artifacts: number;
  bannedOwners: number;
  requests24h: number;
  errors24h: number;
  since: string;
  runtime: Runtime | null;
};

function AdminSystem() {
  const { data, state, refresh } = useJson<SystemOverview>("/api/admin/overview");

  if (state === "loading") return <LoadingBlock label="system status" />;
  if (state === "error" || !data) return <LoadError what="system status" onRetry={() => void refresh()} />;

  const rt = data.runtime;
  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Platform statistics" className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
        <MetricTile label="Accounts" amount={data.owners} hint="With at least one project" />
        <MetricTile label="Projects" amount={data.projects} hint={`${data.activeProjects} with a live route`} />
        <MetricTile label="Deployments" amount={data.deployments} hint={`${data.artifacts} artifacts on disk`} />
        <MetricTile label="Requests" amount={data.requests24h} hint="Last 24 hours, all routes" />
        <MetricTile label="Errors" amount={data.errors24h} hint="5xx, last 24 hours" />
        <MetricTile label="Disabled accounts" amount={data.bannedOwners} hint="Their routes are stopped" />
      </section>
      {rt ? (
        <Section
          title="Sprout processes"
          description="Each running sprout listens on a loopback port from a fixed pool. The pool is a cap that protects the box."
        >
          <UsageMeter label="Port pool" used={rt.portsInUse} limit={rt.portPoolSize} unit="ports" />
          <p className="text-sm text-fg-muted">
            {rt.live} running now, {rt.spawns} started since the edge came up, {rt.idleEvictions} stopped after the idle
            window{rt.restarts > 0 ? `, ${rt.restarts} restarted after a crash` : ""}
            {rt.readyFailures > 0 ? `, ${rt.readyFailures} never began listening` : ""}.
          </p>
        </Section>
      ) : null}
    </div>
  );
}
