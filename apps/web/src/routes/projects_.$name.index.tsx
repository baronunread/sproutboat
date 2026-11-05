import {
  Banner,
  CopyId,
  DescriptionList,
  Link,
  MetricTile,
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  formatNumber,
} from "@sproutboat/ikada";
import { Sparkline } from "@sproutboat/ikada/charts";
import { createFileRoute, Link as RouterLink } from "@tanstack/react-router";
import { useMemo } from "react";
import { relativeTime, useProject } from "../dashboard-data";
import type { DescriptionItem } from "@sproutboat/ikada";
import { Note, Section, fullTime } from "../project-ui";
import { useProjectMetrics } from "../traffic-charts";

export const Route = createFileRoute("/projects_/$name/")({ component: ProjectOverview });

const HOUR = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

function ProjectOverview() {
  const { name, deployments, active } = useProject();
  const activeVersion = deployments.find((deployment) => deployment.active);
  const { metrics, state } = useProjectMetrics(name, "24h");
  const loading = state === "loading" && !metrics;

  const requests = useMemo(() => metrics?.buckets.reduce((sum, bucket) => sum + bucket.count, 0) ?? 0, [metrics]);
  const errors = useMemo(() => metrics?.buckets.reduce((sum, bucket) => sum + bucket.errors, 0) ?? 0, [metrics]);
  const requestSpark = useMemo(() => metrics?.buckets.map((bucket) => bucket.count) ?? [], [metrics]);
  const hasTraffic = Boolean(metrics && requests > 0);
  const successRate = requests ? ((requests - errors) / requests) * 100 : null;

  const items: DescriptionItem[] = [
    {
      id: "status",
      term: "Status",
      details: active ? (
        <StatusDot status="success" live label="Serving the active version" />
      ) : (
        <StatusDot status="neutral" label="Not serving: every version is inactive" />
      ),
    },
    {
      id: "version",
      term: "Current version",
      details: activeVersion ? (
        <RouterLink
          to="/projects/$name/deployments/$id"
          params={{ name, id: activeVersion.id }}
          className="font-mono text-sm underline decoration-hairline-strong underline-offset-4 hover:decoration-fg"
        >
          {activeVersion.id.slice(0, 8)}
        </RouterLink>
      ) : (
        <span className="text-fg-muted">None</span>
      ),
    },
    {
      id: "route",
      term: "Route",
      details: active ? (
        <Link href={`https://${active.hostname}`} external className="break-all">
          {active.hostname}
        </Link>
      ) : (
        <span className="text-fg-muted">None</span>
      ),
    },
    {
      id: "domains",
      term: "Custom domains",
      details: (
        <RouterLink
          to="/projects/$name/triggers"
          params={{ name }}
          className="underline decoration-hairline-strong underline-offset-4 hover:decoration-fg"
        >
          {active?.domains ?? 0} attached
        </RouterLink>
      ),
    },
    {
      id: "deployed",
      term: "Last deploy",
      details: activeVersion ? (
        <span title={fullTime(activeVersion.deployedAt)}>{relativeTime(activeVersion.deployedAt)}</span>
      ) : (
        <span className="text-fg-muted">-</span>
      ),
    },
    { id: "versions", term: "Total versions", details: String(deployments.length) },
  ];

  return (
    <div className="flex flex-col gap-4">
      {state === "error" && !metrics ? (
        <Banner tone="danger">Could not load traffic for this sprout. Refresh and try again.</Banner>
      ) : (
        <section aria-label="Last 24 hours" className="grid gap-3 sm:grid-cols-3">
          <MetricTile
            label="Requests"
            loading={loading}
            noData={Boolean(metrics) && !hasTraffic}
            emptyText="No requests in 24 hours"
            value={formatNumber(requests)}
            hint="Last 24 hours"
            sparkline={
              requestSpark.length > 1 ? (
                <Sparkline
                  data={requestSpark}
                  ariaLabel="Requests per hour, last 24 hours"
                  formatPoint={(index) => HOUR.format(Date.parse(metrics?.buckets[index]?.start ?? ""))}
                />
              ) : undefined
            }
          />
          <MetricTile
            label="Success rate"
            loading={loading}
            noData={Boolean(metrics) && successRate === null}
            emptyText="No requests yet"
            value={successRate === null ? "-" : successRate.toFixed(1)}
            unit="%"
            hint="Last 24 hours"
          />
          <MetricTile
            label="Latency p50"
            loading={loading}
            noData={Boolean(metrics) && !metrics?.latencyMs}
            emptyText="Not enough requests"
            value={metrics?.latencyMs ? formatNumber(metrics.latencyMs.p50) : "-"}
            unit="ms"
            hint="Median response time"
          />
        </section>
      )}

      <Section id="details" title="Details">
        <DescriptionList items={items} />
      </Section>

      <Section
        id="recent"
        title="Recent deployments"
        description="The five newest versions."
        action={
          <RouterLink
            to="/projects/$name/deployments"
            params={{ name }}
            className="text-base font-medium underline decoration-hairline-strong underline-offset-4 hover:decoration-fg"
          >
            View all deployments
          </RouterLink>
        }
      >
        {deployments.length === 0 ? (
          <Note>No versions yet.</Note>
        ) : (
          <Table label="Recent deployments" containerClassName="shadow-none ring-1 ring-hairline">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Version</TableHead>
                <TableHead hideBelow="md">Artifact</TableHead>
                <TableHead hideBelow="sm">Deployed</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deployments.slice(0, 5).map((deployment) => (
                <TableRow key={deployment.id}>
                  <TableCell>
                    <Link
                      render={<RouterLink to="/projects/$name/deployments/$id" params={{ name, id: deployment.id }} />}
                      className="font-mono text-sm"
                    >
                      {deployment.id.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell hideBelow="md">
                    <CopyId
                      value={deployment.artifact}
                      display={deployment.artifact.slice(0, 12)}
                      label="Copy artifact digest"
                    />
                  </TableCell>
                  <TableCell hideBelow="sm" className="whitespace-nowrap text-fg-muted tabular-nums">
                    <span title={fullTime(deployment.deployedAt)}>{relativeTime(deployment.deployedAt)}</span>
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
        )}
      </Section>
    </div>
  );
}
