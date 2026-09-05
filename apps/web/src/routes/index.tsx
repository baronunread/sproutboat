import { useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { defineChart } from "@tanstack/charts";
import { barY } from "@tanstack/charts/bar";
import { focusGroupX } from "@tanstack/charts/focus";
import { Chart } from "@tanstack/charts/react/tooltip";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { stack } from "@tanstack/charts/stack";
import { tooltip } from "@tanstack/charts/tooltip";
import {
  Arrow,
  EmptyState,
  Metric,
  Panel,
  PanelHeading,
  RECORD_TITLE,
  RecordList,
  RecordRow,
  Status,
  StatusMessage,
} from "../components";
import { relativeTime, useOverview } from "../dashboard-data";
import { buttonVariants } from "@/components/ui/button";

/** Built once: an Intl formatter is expensive and this one never varies. */
const HOUR = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/** Module scope: it closes over nothing, so rebuilding it every render only
 *  churned the chart definition's dependencies. */
const hourLabel = (iso: string) => HOUR.format(new Date(iso));

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
    const response = await fetch(`/api/cli/authorizations/${encodeURIComponent(cliCode)}/approve`, {
      method: "POST",
      credentials: "include",
    });
    if (response.ok) history.replaceState({}, "", "/");
  };
  return (
    <>
      <section className="mb-8 flex items-center justify-between gap-8 border-b border-border pb-7 max-[800px]:mb-10 max-[800px]:flex-col max-[800px]:items-start [&_h1]:m-0 [&_h1]:text-[1.85rem] [&_h1]:font-bold [&_h1]:tracking-[-0.035em] [&_h1]:max-[480px]:text-[1.6rem] [&_p]:mt-1.5 [&_p]:max-w-[38rem] [&_p]:text-[0.875rem] [&_p]:leading-normal [&_p]:text-muted-foreground">
        <div>
          <h1>Your deployments, at a glance.</h1>
          <p>Live information from your active routes and deployment history.</p>
        </div>
        <Link className={buttonVariants({ variant: "default", className: "text-[0.82rem]" })} to="/projects">
          View sprouts
        </Link>
      </section>

      {cliCode && (
        <section className="mb-6 flex items-center justify-between gap-8 rounded-lg border border-[color-mix(in_srgb,var(--color-sky)_25%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-sky)_8%,var(--color-card))] p-5 max-[800px]:flex-col max-[800px]:items-start [&_h2]:m-0 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:tracking-tight [&_p]:mt-1.5 [&_p]:max-w-[38rem] [&_p]:text-[0.8rem] [&_p]:leading-relaxed [&_p]:text-muted-foreground">
          <div>
            <h2>Connect this machine to Sproutboat.</h2>
            <p>
              {data
                ? "Approve this browser login to store a local CLI credential."
                : "Sign in and claim a namespace before approving this browser login."}
            </p>
          </div>
          {data ? (
            <button
              className={buttonVariants({ variant: "default", className: "text-[0.82rem]" })}
              type="button"
              onClick={approve}
            >
              Approve login <Arrow />
            </button>
          ) : (
            <Link
              className={buttonVariants({ variant: "default", className: "text-[0.82rem]" })}
              to={state === "sign-in" ? "/login" : "/profile"}
            >
              Continue <Arrow />
            </Link>
          )}
        </section>
      )}

      {state === "loading" ? (
        <Panel variant="bare" className="min-h-56 px-5 pt-12 text-muted-foreground" aria-live="polite">
          Loading workspace data…
        </Panel>
      ) : state === "sign-in" ? (
        <Panel variant="bare">
          <h2>Sign in to view your workspace</h2>
          <p>Sign in to deploy and inspect your services.</p>
          <Link className={buttonVariants({ variant: "default", className: "text-[0.82rem]" })} to="/login">
            Sign in
          </Link>
        </Panel>
      ) : state === "setup" ? (
        <Panel variant="bare">
          <h2>Claim your deployment namespace</h2>
          <p>Set up the namespace that will be used in your project routes.</p>
          <Link className={buttonVariants({ variant: "default", className: "text-[0.82rem]" })} to="/profile">
            Set up profile
          </Link>
        </Panel>
      ) : state === "error" ? (
        <StatusMessage tone="error">Could not load workspace data. Refresh and try again.</StatusMessage>
      ) : (
        <>
          <AccountTrend trend={metrics?.trend ?? []} requests={metrics?.requestsLast24Hours ?? 0} />

          <section
            className="mb-6 grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-3 max-[480px]:grid-cols-1 max-[480px]:gap-2.5"
            aria-label="Deployment statistics"
          >
            <Metric
              label="Active projects"
              value={metrics ? String(metrics.activeProjects) : "—"}
              detail="Routes currently serving"
            />
            <Metric
              label="Deployments"
              value={metrics ? String(metrics.deployments) : "—"}
              detail="Immutable versions"
            />
            <Metric
              label="Requests"
              value={metrics ? String(metrics.requestsLast24Hours) : "—"}
              detail="Last 24 hours"
            />
            <Metric
              label="Success rate"
              value={metrics ? (metrics.successRate === null ? "—" : `${metrics.successRate}%`) : "—"}
              detail={metrics?.successRate === null ? "No requests yet" : "Last 24 hours"}
            />
          </section>

          <Panel variant="bare">
            <PanelHeading title="Recent deployments" description="The ten most recent versions across every sprout." />
            {data?.deployments.length ? (
              <RecordList>
                {data.deployments.slice(0, 10).map((deployment) => (
                  <RecordRow key={deployment.id}>
                    <div>
                      <Link
                        className={RECORD_TITLE}
                        to="/projects/$name/deployments/$id"
                        params={{ name: deployment.project, id: deployment.id }}
                      >
                        {deployment.project}
                      </Link>
                      <small>
                        Version {deployment.id.slice(0, 8)} · {deployment.hostname}
                      </small>
                    </div>
                    <code title={`Artifact ${deployment.artifact}`}>Artifact {deployment.artifact.slice(0, 12)}</code>
                    <span>{relativeTime(deployment.deployedAt)}</span>
                    <Status live={deployment.active}>{deployment.active ? "Active" : "Inactive"}</Status>
                  </RecordRow>
                ))}
              </RecordList>
            ) : (
              <EmptyDeployment />
            )}
          </Panel>
        </>
      )}
    </>
  );
}

/**
 * #76 — the account-wide traffic trend Cloudflare puts on its Workers home:
 * 24 hourly buckets across every route this account owns, from the same scan
 * that produces the request/success metrics.
 */
function AccountTrend({
  trend,
  requests,
}: {
  trend: Array<{ start: string; count: number; errors: number }>;
  requests: number;
}) {
  if (trend.length === 0 || requests === 0) return null;
  return <AccountTrendChart trend={trend} />;
}

type TrendRow = { start: string; series: "errors" | "requests"; value: number };

/** Same shape as the project metrics chart: stacked buckets, errors at the
 *  base, one grouped tooltip per hour, keyboard-navigable. Kept as its own
 *  component so the hooks below sit above no early return. */
function AccountTrendChart({ trend }: { trend: Array<{ start: string; count: number; errors: number }> }) {
  const max = Math.max(1, ...trend.map((bucket) => bucket.count));

  const rows = useMemo<TrendRow[]>(
    () =>
      trend.flatMap((bucket) => [
        { start: bucket.start, series: "errors" as const, value: bucket.errors },
        { start: bucket.start, series: "requests" as const, value: Math.max(0, bucket.count - bucket.errors) },
      ]),
    [trend],
  );

  const definition = useMemo(
    () =>
      defineChart(
        {
          marks: [
            barY(rows, {
              x: "start",
              y: "value",
              z: "series",
              fill: (row: TrendRow) => (row.series === "errors" ? "var(--coral)" : "var(--muted)"),
              layout: stack(),
            }),
          ],
          scales: {
            x: { scale: scaleBand, axis: { ticks: { format: hourLabel }, tickLabels: { thin: true } } },
            y: { scale: scaleLinear, nice: true },
          },
        },
        { focus: focusGroupX, tooltip },
      ),
    [rows],
  );

  return (
    <Panel variant="wide" className="mb-6">
      <PanelHeading title="Traffic" description="Requests across every route on this account, last 24 hours." />
      <Chart
        definition={definition}
        ariaLabel={`Requests per hour across all routes, peak ${max} in one bucket`}
        height={96}
        className="mt-4 block w-full"
        renderTooltipBody={({ points }) => {
          const first = points[0]?.datum;
          if (!first) return null;
          const bucket = trend.find((candidate) => candidate.start === first.start);
          if (!bucket) return null;
          return (
            <div className="grid gap-0.5 text-[0.75rem] tabular-nums">
              <span className="text-muted-foreground">{hourLabel(bucket.start)}</span>
              <span>
                {bucket.count} request{bucket.count === 1 ? "" : "s"}
              </span>
              <span className={bucket.errors > 0 ? "text-coral" : "text-muted-foreground"}>
                {bucket.errors} error{bucket.errors === 1 ? "" : "s"}
              </span>
            </div>
          );
        }}
      />
    </Panel>
  );
}

export function EmptyDeployment() {
  return (
    <EmptyState title="Deploy your first sprout">
      <p>Deploy from a project directory and its route, version history and traffic appear here.</p>
      <code className="mt-3 inline-block rounded-[5px] border border-border bg-background p-2.5 text-[0.76rem]">
        sproutboat deploy hello
      </code>
    </EmptyState>
  );
}
