import { Banner, EmptyState, MetricTile, SegmentedControl, cn, formatBytes, formatNumber } from "@sproutboat/ikada";
import type { MetricDelta } from "@sproutboat/ikada";
import { Sparkline, chartClassName, chartColors, statusClassColor } from "@sproutboat/ikada/charts";
import { defineChart } from "@tanstack/charts";
import { barY } from "@tanstack/charts/bar";
import { focusGroupX } from "@tanstack/charts/focus";
import { Chart } from "@tanstack/charts/react/tooltip";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { stack } from "@tanstack/charts/stack";
import { tooltip } from "@tanstack/charts/tooltip";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Section } from "./project-ui";

export type StatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "other";
type Bucket = { start: string; count: number; errors: number; coldStarts: number };
type Percentiles = { p50: number; p90: number; p99: number };
export type Metrics = {
  range: string;
  from: string;
  to: string;
  bucketMs: number;
  buckets: Bucket[];
  statusDistribution: Record<StatusClass, number>;
  methodDistribution: Record<string, number>;
  invocationStatus: Record<string, number>;
  latencyMs: Percentiles | null;
  ttfbMs: Percentiles | null;
  cpuMs: Percentiles | null;
  startupMs: Percentiles | null;
  bootMs: Percentiles | null;
  coldStarts: number;
  bytesIn: number;
  bytesOut: number;
  cacheHitRate: number | null;
  cacheHits: number;
  sampleCount: number;
  previous: { requests: number; errors: number; latencyP50: number | null };
  windowTruncated: boolean;
};

/** One GET of a project's metrics for a range; keeps the last result on screen while the next one loads. */
export function useProjectMetrics(name: string, range: string) {
  const [metrics, setMetrics] = useState<Metrics>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(name)}/metrics?range=${range}`, {
        credentials: "include",
      });
      if (!response.ok) {
        setState("error");
        return;
      }
      // SAFETY: a 2xx from the metrics endpoint is the Metrics contract.
      setMetrics((await response.json()) as Metrics);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [name, range]);
  useEffect(() => {
    void load();
  }, [load]);
  return { metrics, state };
}

const RANGES = [
  { value: "1h", label: "1h", ariaLabel: "Last 1 hour" },
  { value: "6h", label: "6h", ariaLabel: "Last 6 hours" },
  { value: "24h", label: "24h", ariaLabel: "Last 24 hours" },
  { value: "7d", label: "7d", ariaLabel: "Last 7 days" },
] as const;
type Range = (typeof RANGES)[number]["value"];
const STATUS_ROWS: readonly StatusClass[] = ["2xx", "3xx", "4xx", "5xx", "other"];
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const group = (value: number) => formatNumber(value);

/**
 * A change past ~3x reads as noise as a percentage ("4800.0%"), so report the
 * multiple instead and keep one decimal only where it carries information.
 */
function formatDelta(delta: number): string {
  const magnitude = Math.abs(delta);
  if (magnitude >= 300) return `${(magnitude / 100 + 1).toFixed(1)}x`;
  return `${magnitude.toFixed(magnitude < 10 ? 1 : 0)}%`;
}

/** Signed percentage change, or null when there is no prior baseline. */
function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

/** The tile's change chip against the previous window of the same length; flat or unknown changes show a hint instead. */
interface DeltaTile {
  delta?: MetricDelta;
  hint: string;
}

function deltaProps(delta: number | null, goodWhen: "up" | "down"): DeltaTile {
  if (delta === null) return { hint: "No prior data" };
  if (Math.abs(delta) < 0.5) return { hint: "No change vs previous" };
  const direction = delta > 0 ? "up" : "down";
  return {
    delta: {
      value: formatDelta(delta),
      direction,
      sentiment: direction === goodWhen ? "good" : "bad",
    },
    hint: "vs previous period",
  };
}

/** A card with one metric group, e.g. latency percentiles. Each stat is a term and its value. */
function StatCard({
  id,
  title,
  subtitle,
  stats,
  note,
}: {
  id: string;
  title: string;
  subtitle?: string;
  stats: ReadonlyArray<{ label: string; value: string }>;
  note?: ReactNode;
}) {
  return (
    <Section id={id} title={title} description={subtitle}>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        {stats.map((stat) => (
          <div key={stat.label} className="min-w-0">
            <dt className="text-sm text-fg-muted">{stat.label}</dt>
            <dd className="m-0 text-lg font-semibold tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>
      {note ? <p className="text-sm text-fg-muted [&_code]:font-mono [&_code]:text-fg">{note}</p> : null}
    </Section>
  );
}

const ms = (value: number) => `${group(value)} ms`;
const percentileStats = (p: Percentiles) => [
  { label: "p50", value: ms(p.p50) },
  { label: "p90", value: ms(p.p90) },
  { label: "p99", value: ms(p.p99) },
];

/**
 * One distribution row: label, a track that always spans the same free space,
 * and a right-aligned tabular count. Sharing the component keeps status codes,
 * invocation status and methods on identical column edges.
 */
function DistributionRow({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  const percent = total ? Math.round((value / total) * 100) : 0;
  return (
    <div className="grid grid-cols-[minmax(4.5rem,6rem)_minmax(0,1fr)_auto] items-center gap-x-3.5">
      <dt className="text-sm tabular-nums text-fg-muted [overflow-wrap:anywhere]">{label}</dt>
      <dd className="contents">
        <div className="h-2 overflow-hidden rounded-full bg-well">
          <span
            className="block h-full min-w-0.5 rounded-[inherit]"
            style={{ width: `${percent}%`, backgroundColor: color }}
          />
        </div>
        <span className="text-end text-sm whitespace-nowrap tabular-nums">
          {group(value)}
          <small className="ms-1.5 text-fg-muted">{percent}%</small>
        </span>
      </dd>
    </div>
  );
}

function Distribution({
  id,
  title,
  rows,
  total,
  note,
}: {
  id: string;
  title: string;
  rows: ReadonlyArray<{ label: string; value: number; color: string }>;
  total: number;
  note?: ReactNode;
}) {
  return (
    <Section id={id} title={title}>
      <dl className="m-0 grid gap-2.5">
        {rows.map((row) => (
          <DistributionRow key={row.label} {...row} total={total} />
        ))}
      </dl>
      {note ? <p className="text-sm text-fg-muted [&_code]:font-mono [&_code]:text-fg">{note}</p> : null}
    </Section>
  );
}

/** The KPI row. Its totals are derived from the buckets rather than served, so it owns that arithmetic. */
function KpiTiles({ metrics, tickLabel }: { metrics: Metrics; tickLabel: (iso: string) => string }) {
  const requests = metrics.buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const errors = metrics.buckets.reduce((sum, bucket) => sum + bucket.errors, 0);
  const errorRate = requests ? (errors / requests) * 100 : 0;
  const previousErrorRate = metrics.previous.requests ? (metrics.previous.errors / metrics.previous.requests) * 100 : 0;
  const latencyDelta =
    metrics.latencyMs && metrics.previous.latencyP50 !== null
      ? deltaPct(metrics.latencyMs.p50, metrics.previous.latencyP50)
      : null;
  const point = (index: number) => tickLabel(metrics.buckets[index]?.start ?? "");

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      <MetricTile
        label="Requests"
        value={group(requests)}
        {...deltaProps(deltaPct(requests, metrics.previous.requests), "up")}
        sparkline={
          metrics.buckets.length > 1 ? (
            <Sparkline
              data={metrics.buckets.map((bucket) => bucket.count)}
              ariaLabel="Requests per bucket"
              formatPoint={point}
            />
          ) : undefined
        }
      />
      <MetricTile
        label="Error rate"
        value={errorRate.toFixed(1)}
        unit="%"
        {...deltaProps(deltaPct(errorRate, previousErrorRate), "down")}
        sparkline={
          metrics.buckets.length > 1 && errors > 0 ? (
            <Sparkline
              data={metrics.buckets.map((bucket) => bucket.errors)}
              color="errors"
              ariaLabel="Errors per bucket"
              formatPoint={point}
            />
          ) : undefined
        }
      />
      <MetricTile
        label="Latency p50"
        value={metrics.latencyMs ? group(metrics.latencyMs.p50) : "-"}
        unit={metrics.latencyMs ? "ms" : undefined}
        {...deltaProps(latencyDelta, "down")}
      />
      <MetricTile
        label="Cache hit rate"
        value={metrics.cacheHitRate === null ? "-" : metrics.cacheHitRate.toFixed(1)}
        unit={metrics.cacheHitRate === null ? undefined : "%"}
        hint="Served from the edge cache"
      />
      <MetricTile
        label="Cold starts"
        value={group(metrics.coldStarts)}
        hint="Spawn to listening"
        sparkline={
          metrics.buckets.length > 1 && metrics.coldStarts > 0 ? (
            <Sparkline
              data={metrics.buckets.map((bucket) => bucket.coldStarts)}
              color="series"
              ariaLabel="Cold starts per bucket"
              formatPoint={point}
            />
          ) : undefined
        }
      />
    </div>
  );
}

/** #10: request/error time series, status distribution, and latency percentiles for one project. */
export function TrafficCharts({ name }: { name: string }) {
  const [range, setRange] = useState<Range>("24h");
  const { metrics, state } = useProjectMetrics(name, range);

  const wide = range === "7d";
  const tickLabel = useCallback((iso: string) => (wide ? DAY : CLOCK).format(new Date(iso)), [wide]);
  const loading = state === "loading";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-md font-semibold">Traffic</h2>
          <p className="mt-0.5 text-base text-fg-muted">
            Aggregated from edge request logs. Coarse buckets over a bounded scan, not a metrics platform.
          </p>
        </div>
        <div className="w-full sm:w-64">
          <SegmentedControl options={RANGES} value={range} onValueChange={setRange} aria-label="Time range" />
        </div>
      </div>

      {state === "error" ? (
        <Banner tone="danger">Could not load traffic. Refresh and try again.</Banner>
      ) : !metrics ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5" aria-live="polite">
          {["Requests", "Error rate", "Latency p50", "Cache hit rate", "Cold starts"].map((label) => (
            <MetricTile key={label} label={label} loading />
          ))}
        </div>
      ) : metrics.sampleCount === 0 ? (
        <div className="rounded-xl bg-surface p-4 shadow-card">
          <EmptyState
            as="h3"
            title="No requests in this range"
            description="No requests to this route in the selected range."
          />
        </div>
      ) : (
        <div
          aria-busy={loading || undefined}
          className={cn(
            "flex flex-col gap-4 transition-opacity duration-(--sb-duration-hover)",
            loading && "opacity-60",
          )}
        >
          {metrics.windowTruncated ? (
            <Banner tone="info">Older activity beyond the scan window is not included in these totals.</Banner>
          ) : null}

          <KpiTiles metrics={metrics} tickLabel={tickLabel} />

          <RequestBars buckets={metrics.buckets} tickLabel={tickLabel} />

          <div className="grid gap-4 lg:grid-cols-2">
            <Distribution
              id="status"
              title="Status codes"
              total={metrics.sampleCount}
              rows={STATUS_ROWS.map((cls) => ({
                label: cls,
                value: metrics.statusDistribution[cls],
                color: statusClassColor(cls),
              }))}
            />
            {metrics.latencyMs ? (
              <StatCard
                id="latency"
                title="Latency"
                stats={percentileStats(metrics.latencyMs)}
                note={`Nearest-rank percentiles over ${group(metrics.sampleCount)} request${metrics.sampleCount === 1 ? "" : "s"}. The final bucket is still filling.`}
              />
            ) : (
              <StatCard
                id="latency"
                title="Latency"
                stats={[]}
                note="Not enough requests to compute latency percentiles."
              />
            )}
            {metrics.ttfbMs ? (
              <StatCard
                id="ttfb"
                title="Time to first byte"
                subtitle="Edge to sprout response"
                stats={percentileStats(metrics.ttfbMs)}
              />
            ) : null}
            {metrics.cpuMs ? (
              <StatCard
                id="cpu"
                title="CPU time"
                subtitle="Per invocation"
                stats={percentileStats(metrics.cpuMs)}
                note={
                  <>
                    CPU consumed by the handler, self-reported per request (sync and <code>async</code>). Responses with
                    a streamed body or a <code>Set-Cookie</code> header are excluded, so this covers a subset of
                    requests.
                  </>
                }
              />
            ) : null}
            <StatCard
              id="cold"
              title="Cold starts"
              subtitle="Spawn to listening"
              stats={[
                { label: "Cold starts", value: group(metrics.coldStarts) },
                {
                  label: "Of requests",
                  value: metrics.sampleCount ? `${Math.round((metrics.coldStarts / metrics.sampleCount) * 100)}%` : "-",
                },
                { label: "Startup p50", value: metrics.startupMs ? ms(metrics.startupMs.p50) : "-" },
                { label: "Startup p90", value: metrics.startupMs ? ms(metrics.startupMs.p90) : "-" },
                { label: "Boot p50", value: metrics.bootMs ? ms(metrics.bootMs.p50) : "-" },
                {
                  label: "Eval p50",
                  value:
                    metrics.startupMs && metrics.bootMs
                      ? ms(Math.max(0, metrics.startupMs.p50 - metrics.bootMs.p50))
                      : "-",
                },
              ]}
              note={
                <>
                  A cold start is a request that had to launch the sprout process (first hit after a deploy, crash, or
                  idle eviction). <strong>Boot</strong> is process creation and runtime init; <strong>eval</strong> is
                  JS module evaluation and binding the listen socket.
                </>
              }
            />
            <StatCard
              id="transfer"
              title="Transfer"
              stats={[
                { label: "Request body in", value: formatBytes(metrics.bytesIn) },
                { label: "Response body out", value: formatBytes(metrics.bytesOut) },
              ]}
              note="Body bytes only, from Content-Length; streamed responses without a length are not counted."
            />
            {Object.keys(metrics.invocationStatus).some((key) => key !== "ok") ? (
              <Distribution
                id="invocation"
                title="Invocation status"
                total={metrics.sampleCount}
                rows={Object.entries(metrics.invocationStatus)
                  .toSorted((a, b) => b[1] - a[1])
                  .map(([status, value]) => ({
                    label: status,
                    value,
                    color: statusClassColor(status === "ok" ? "2xx" : "5xx"),
                  }))}
                note={
                  <>
                    <code>timed-out</code> and <code>response-too-large</code> are platform caps;{" "}
                    <code>sprout-unavailable</code> and <code>proxy</code> mean the edge could not reach the sprout.
                  </>
                }
              />
            ) : null}
            {Object.keys(metrics.methodDistribution).length > 0 ? (
              <Distribution
                id="methods"
                title="Methods"
                total={metrics.sampleCount}
                rows={Object.entries(metrics.methodDistribution)
                  .toSorted((a, b) => b[1] - a[1])
                  .map(([method, value]) => ({ label: method, value, color: chartColors.series }))}
              />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/** One stacked bar per time bucket: errors solid at the base, successes above.
 *  The split is read by height, which a hatch fill over the same bar is not.
 *
 *  `focusGroupX` gives the whole bucket to one hover, so the tooltip reports
 *  requests and errors together instead of whichever rect the pointer landed
 *  on. Keyboard users get the same points: arrows walk the buckets, Enter
 *  pins, Escape dismisses. */
type BarRow = { start: string; series: "errors" | "requests"; value: number };

function RequestBars({ buckets, tickLabel }: { buckets: Bucket[]; tickLabel: (iso: string) => string }) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const rows = useMemo<BarRow[]>(
    () =>
      buckets.flatMap((bucket) => [
        { start: bucket.start, series: "errors" as const, value: bucket.errors },
        { start: bucket.start, series: "requests" as const, value: Math.max(0, bucket.count - bucket.errors) },
      ]),
    [buckets],
  );

  // One tick per distinct label. At 7d the formatter is month+day, so every
  // bucket inside a day formats identically and the axis would read
  // "1 set, 1 set, 1 set". Thinning only prevents overlap, not repetition.
  const tickValues = useMemo(() => {
    const seen = new Set<string>();
    const values: string[] = [];
    for (const bucket of buckets) {
      const label = tickLabel(bucket.start);
      if (seen.has(label)) continue;
      seen.add(label);
      values.push(bucket.start);
    }
    return values;
  }, [buckets, tickLabel]);

  const definition = useMemo(
    () =>
      defineChart(
        {
          marks: [
            barY(rows, {
              x: "start",
              y: "value",
              z: "series",
              fill: (row: BarRow) => (row.series === "errors" ? chartColors.errors : chartColors.requests),
              layout: stack(),
            }),
          ],
          scales: {
            x: {
              scale: scaleBand,
              // Without a format the band scale labels every bucket with its raw
              // ISO start. `thin` then drops whatever would still collide.
              axis: { ticks: { values: tickValues, format: tickLabel }, tickLabels: { thin: true } },
            },
            y: { scale: scaleLinear, nice: true },
          },
        },
        { focus: focusGroupX, tooltip },
      ),
    [rows, tickValues, tickLabel],
  );

  return (
    <Section
      id="requests"
      title="Requests"
      description={`Peak ${group(max)} per bucket`}
      action={
        <p className="flex items-center gap-3 text-sm text-fg-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-xs" style={{ backgroundColor: chartColors.requests }} />
            Requests
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-xs" style={{ backgroundColor: chartColors.errors }} />
            5xx errors
          </span>
        </p>
      }
    >
      <Chart
        definition={definition}
        ariaLabel={`Requests per time bucket, peak ${max}`}
        height={180}
        className={cn(chartClassName, "block w-full text-fg-muted")}
        renderTooltipBody={({ points }) => {
          const first = points[0]?.datum;
          if (!first) return null;
          const bucket = buckets.find((candidate) => candidate.start === first.start);
          if (!bucket) return null;
          return (
            <div className="grid gap-0.5 text-xs tabular-nums">
              <span className="text-fg-muted">{tickLabel(bucket.start)}</span>
              <span>
                {group(bucket.count)} request{bucket.count === 1 ? "" : "s"}
              </span>
              <span className={bucket.errors > 0 ? "text-danger-fg" : "text-fg-muted"}>
                {group(bucket.errors)} error{bucket.errors === 1 ? "" : "s"}
              </span>
            </div>
          );
        }}
      />
    </Section>
  );
}
