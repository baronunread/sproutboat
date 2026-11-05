import {
  Badge,
  Banner,
  EmptyState,
  Link,
  MetricTile,
  PageHeader,
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  buttonStyles,
  formatNumber,
} from "@sproutboat/ikada";
import { Sparkline, TimeseriesChart } from "@sproutboat/ikada/charts";
import type { TimeseriesSeries } from "@sproutboat/ikada/charts";
import { createFileRoute, Link as RouterLink } from "@tanstack/react-router";
import { useMemo } from "react";
import { relativeTime, useOverview } from "../dashboard-data";
import type { Overview } from "../dashboard-data";
import { EmptySprouts } from "../empty-sprouts";

/** Built once: an Intl formatter is expensive and this one never varies. */
const HOUR = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const hourLabel = (time: number) => HOUR.format(new Date(time));

// __root.tsx's AuthGate redirects anon visitors to /login once the session
// check resolves; useOverview also has its own sign-in state as a fallback.
export const Route = createFileRoute("/")({
  component: OverviewPage,
  head: () => ({ meta: [{ title: "Sproutboat" }] }),
});

function OverviewPage() {
  const { data, state } = useOverview();
  const metrics = data?.metrics;
  const trend = useMemo(() => metrics?.trend ?? [], [metrics]);
  const loading = state === "loading";
  const requestsSpark = useMemo(() => trend.map((bucket) => bucket.count), [trend]);
  const errorsSpark = useMemo(() => trend.map((bucket) => bucket.errors), [trend]);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Overview"
        description="Live information from your active routes and deployment history."
        actions={
          <RouterLink to="/projects" className={buttonStyles({ variant: "primary" })}>
            View sprouts
          </RouterLink>
        }
      />

      {state === "sign-in" ? (
        <EmptyState
          title="Sign in to view your workspace"
          description="Sign in to deploy and inspect your services."
          action={
            <RouterLink to="/login" className={buttonStyles({ variant: "primary" })}>
              Sign in
            </RouterLink>
          }
        />
      ) : state === "error" ? (
        <Banner tone="danger">Could not load workspace data. Refresh and try again.</Banner>
      ) : (
        <>
          <section aria-label="Deployment statistics" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricTile
              label="Active projects"
              loading={loading}
              value={metrics ? String(metrics.activeProjects) : "-"}
              hint="Routes currently serving"
            />
            <MetricTile
              label="Deployments"
              loading={loading}
              value={metrics ? String(metrics.deployments) : "-"}
              hint="Immutable versions"
            />
            <MetricTile
              label="Requests"
              loading={loading}
              value={metrics ? formatNumber(metrics.requestsLast24Hours) : "-"}
              hint="Last 24 hours"
              sparkline={
                requestsSpark.length > 1 ? (
                  <Sparkline
                    data={requestsSpark}
                    ariaLabel="Requests per hour, last 24 hours"
                    formatPoint={(index) => hourLabel(Date.parse(trend[index]?.start ?? ""))}
                  />
                ) : undefined
              }
            />
            <MetricTile
              label="Success rate"
              loading={loading}
              value={metrics?.successRate === null || metrics === undefined ? "-" : String(metrics.successRate)}
              unit={metrics?.successRate === null || metrics === undefined ? undefined : "%"}
              hint={metrics?.successRate === null ? "No requests yet" : "Last 24 hours"}
              sparkline={
                errorsSpark.some((count) => count > 0) ? (
                  <Sparkline
                    data={errorsSpark}
                    color="errors"
                    ariaLabel="Errors per hour, last 24 hours"
                    formatPoint={(index) => hourLabel(Date.parse(trend[index]?.start ?? ""))}
                  />
                ) : undefined
              }
            />
          </section>

          <AccountTrend trend={trend} requests={metrics?.requestsLast24Hours ?? 0} />

          <section aria-labelledby="recent-title" className="flex flex-col gap-3">
            <div>
              <h2 id="recent-title" className="text-md font-semibold">
                Recent deployments
              </h2>
              <p className="text-base text-fg-muted">The ten most recent versions across every sprout.</p>
            </div>
            {loading ? (
              <Table label="Recent deployments" aria-busy="true">
                <RecentHead />
                <TableBody>
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={5} className="text-center text-fg-muted">
                      Loading deployments…
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            ) : data?.deployments.length ? (
              <RecentDeployments deployments={data.deployments.slice(0, 10)} />
            ) : (
              <div className="rounded-xl bg-surface p-4 shadow-card">
                <EmptySprouts />
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function RecentHead() {
  return (
    <TableHeader>
      <TableRow className="hover:bg-transparent">
        <TableHead>Sprout</TableHead>
        <TableHead hideBelow="sm">Version</TableHead>
        <TableHead hideBelow="lg">Artifact</TableHead>
        <TableHead hideBelow="md">Deployed</TableHead>
        <TableHead>Status</TableHead>
      </TableRow>
    </TableHeader>
  );
}

function RecentDeployments({ deployments }: { deployments: Overview["deployments"] }) {
  return (
    <Table label="Recent deployments">
      <RecentHead />
      <TableBody>
        {deployments.map((deployment) => (
          <TableRow key={deployment.id}>
            <TableCell className="min-w-0">
              <Link
                render={
                  <RouterLink
                    to="/projects/$name/deployments/$id"
                    params={{ name: deployment.project, id: deployment.id }}
                  />
                }
                className="max-w-full truncate"
              >
                {deployment.project}
              </Link>
              <span className="block truncate text-sm text-fg-muted">{deployment.hostname}</span>
            </TableCell>
            <TableCell hideBelow="sm" className="font-mono text-sm whitespace-nowrap">
              {deployment.id.slice(0, 8)}
            </TableCell>
            <TableCell hideBelow="lg" className="font-mono text-sm whitespace-nowrap text-fg-muted">
              <span title={`Artifact ${deployment.artifact}`}>{deployment.artifact.slice(0, 12)}</span>
            </TableCell>
            <TableCell hideBelow="md" className="whitespace-nowrap text-fg-muted tabular-nums">
              {relativeTime(deployment.deployedAt)}
            </TableCell>
            <TableCell className="whitespace-nowrap">
              {deployment.active ? (
                <StatusDot status="success" live label="Active" />
              ) : (
                <StatusDot status="neutral" label="Inactive" />
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * The account-wide traffic trend: 24 hourly buckets across every route this account
 * owns, from the same scan that produces the request and success metrics.
 */
function AccountTrend({ trend, requests }: { trend: NonNullable<Overview["metrics"]["trend"]>; requests: number }) {
  const series = useMemo<TimeseriesSeries[]>(() => {
    const point = (value: (bucket: (typeof trend)[number]) => number) =>
      trend.map((bucket) => ({ time: Date.parse(bucket.start), value: value(bucket) }));
    return [
      { id: "requests", label: "Requests", data: point((bucket) => bucket.count), area: true },
      { id: "errors", label: "Errors", data: point((bucket) => bucket.errors), color: "errors" },
    ];
  }, [trend]);
  if (trend.length === 0 || requests === 0) return null;
  const peak = Math.max(1, ...trend.map((bucket) => bucket.count));
  return (
    <section
      aria-labelledby="traffic-title"
      className="flex flex-col gap-3 rounded-xl bg-surface p-4 shadow-card sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div>
          <h2 id="traffic-title" className="text-md font-semibold">
            Traffic
          </h2>
          <p className="text-base text-fg-muted">Requests across every route on this account, last 24 hours.</p>
        </div>
        <Badge tone="neutral">Peak {formatNumber(peak)} per hour</Badge>
      </div>
      <TimeseriesChart
        series={series}
        height={180}
        ariaLabel={`Requests and errors per hour across all routes, peak ${peak} in one bucket`}
        formatTime={hourLabel}
      />
    </section>
  );
}
