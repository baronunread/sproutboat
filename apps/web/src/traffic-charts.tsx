import { useCallback, useEffect, useMemo, useState } from "react";
import { defineChart } from "@tanstack/charts";
import { barY } from "@tanstack/charts/bar";
import { focusGroupX } from "@tanstack/charts/focus";
import { Chart } from "@tanstack/charts/react/tooltip";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { stack } from "@tanstack/charts/stack";
import { tooltip } from "@tanstack/charts/tooltip";
import { Panel, PanelHeading, SelectField, StatusMessage } from "./components";
import { cn } from "@/lib/utils";

const STATUS_BAR = "block h-full min-w-0.5 rounded-[inherit] bg-muted-foreground";
const STATUS_BAR_TONE = {
  "2xx": "bg-success",
  "3xx": "bg-sky",
  "4xx": "bg-coral",
  "5xx": "bg-coral",
  other: "",
} satisfies Record<StatusClass, string>;

type StatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "other";
type Bucket = { start: string; count: number; errors: number; coldStarts: number };
type Percentiles = { p50: number; p90: number; p99: number };
type Metrics = {
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

const KB = 1024;
const bytes = (value: number) => {
  if (value < KB) return `${value} B`;
  if (value < KB * KB) return `${(value / KB).toFixed(1)} KB`;
  if (value < KB * KB * KB) return `${(value / (KB * KB)).toFixed(1)} MB`;
  return `${(value / (KB * KB * KB)).toFixed(2)} GB`;
};

const RANGES: ReadonlyArray<readonly [string, string]> = [
  ["1h", "1 hour"],
  ["6h", "6 hours"],
  ["24h", "24 hours"],
  ["7d", "7 days"],
];
const STATUS_ROWS: readonly StatusClass[] = ["2xx", "3xx", "4xx", "5xx", "other"];
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const group = (value: number) => value.toLocaleString();

/**
 * One distribution row: label, a track that always spans the same free space,
 * and a right-aligned tabular count. Sharing the component keeps status codes,
 * invocation status and methods on identical column edges.
 */
function DistributionRow({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone?: StatusClass;
}) {
  const percent = total ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <div className="h-2 overflow-hidden rounded-full bg-secondary">
          <span
            className={tone ? cn(STATUS_BAR, STATUS_BAR_TONE[tone]) : STATUS_BAR}
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="text-end text-[0.75rem] whitespace-nowrap tabular-nums [&_small]:ms-1.5 [&_small]:text-muted-foreground">
          {group(value)}
          <small>{percent}%</small>
        </span>
      </dd>
    </div>
  );
}

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

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? 100 / (values.length - 1) : 0;
  const points = values.map((v, i) => `${(i * step).toFixed(2)},${(20 - (v / max) * 20).toFixed(2)}`).join(" ");
  return (
    // Decorative: the card states the value and its delta in text, so the
    // sparkline is hidden rather than given a role it would then have to label.
    <svg className="mt-0.5 block h-[1.6rem] w-full" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke="var(--sky)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** #37: KPI card — value, delta chip vs the previous same-length window, sparkline. */
function MetricCard({
  title,
  value,
  delta,
  goodWhen = "up",
  spark,
}: {
  title: string;
  value: string;
  delta: number | null;
  goodWhen?: "up" | "down";
  spark?: number[];
}) {
  const dir = delta === null || Math.abs(delta) < 0.5 ? "flat" : delta > 0 ? "up" : "down";
  const tone = dir === "flat" ? "flat" : (dir === "up") === (goodWhen === "up") ? "up" : "down";
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-4 py-3.5">
      <span className="text-[0.72rem] text-muted-foreground">{title}</span>
      <span className="text-2xl tracking-tight tabular-nums">{value}</span>
      <span
        className={cn(
          "text-[0.72rem] tabular-nums",
          tone === "up" && "text-brand",
          tone === "down" && "text-coral",
          tone === "flat" && "text-muted-foreground",
        )}
      >
        {delta === null ? "— no prior data" : `${delta > 0 ? "↑" : delta < 0 ? "↓" : ""} ${formatDelta(delta)} vs prev`}
      </span>
      {spark && spark.length > 1 && <Sparkline values={spark} />}
    </div>
  );
}

/** The KPI row. Its totals are derived from the buckets rather than served, so
 *  it owns that arithmetic instead of running it inside the render tree. */
function KpiCards({ metrics }: { metrics: Metrics }) {
  const requests = metrics.buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const errors = metrics.buckets.reduce((sum, bucket) => sum + bucket.errors, 0);
  const errorRate = requests ? (errors / requests) * 100 : 0;
  const previousErrorRate = metrics.previous.requests ? (metrics.previous.errors / metrics.previous.requests) * 100 : 0;
  const latencyDelta =
    metrics.latencyMs && metrics.previous.latencyP50 !== null
      ? deltaPct(metrics.latencyMs.p50, metrics.previous.latencyP50)
      : null;

  return (
    <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] gap-3">
      <MetricCard
        title="Requests"
        value={group(requests)}
        goodWhen="up"
        delta={deltaPct(requests, metrics.previous.requests)}
        spark={metrics.buckets.map((bucket) => bucket.count)}
      />
      <MetricCard
        title="Error rate"
        value={`${errorRate.toFixed(1)}%`}
        goodWhen="down"
        delta={deltaPct(errorRate, previousErrorRate)}
        spark={metrics.buckets.map((bucket) => bucket.errors)}
      />
      <MetricCard
        title="Latency p50"
        goodWhen="down"
        delta={latencyDelta}
        value={metrics.latencyMs ? `${group(metrics.latencyMs.p50)} ms` : "—"}
      />
      <MetricCard
        title="Cache hit rate"
        goodWhen="up"
        delta={null}
        value={metrics.cacheHitRate === null ? "—" : `${metrics.cacheHitRate.toFixed(1)}%`}
      />
      <MetricCard
        title="Cold starts"
        value={group(metrics.coldStarts)}
        goodWhen="down"
        delta={null}
        spark={metrics.buckets.map((bucket) => bucket.coldStarts)}
      />
    </div>
  );
}

/** #10: request/error time series, status distribution, and latency percentiles for one project. */
export function TrafficCharts({ name }: { name: string }) {
  const [range, setRange] = useState("24h");
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

  const wide = range === "7d";
  const tickLabel = (iso: string) => (wide ? DAY : CLOCK).format(new Date(iso));

  return (
    <Panel variant="wide">
      <PanelHeading
        title="Traffic"
        description="Aggregated from edge request logs. Coarse buckets over a bounded scan — not a metrics platform."
        action={
          <SelectField
            label="Time range"
            hideLabel
            value={range}
            fieldClassName="min-w-44 shrink-0"
            options={RANGES.map(([value, label]) => [value, `Last ${label}`] as const)}
            onValueChange={(value) => setRange(value)}
          />
        }
      />

      {state === "loading" ? (
        <p className="min-h-56 px-5 pt-12 text-muted-foreground group-[.is-padded]/panel:px-0" aria-live="polite">
          Loading traffic…
        </p>
      ) : state === "error" || !metrics ? (
        <StatusMessage tone="error">Could not load traffic. Refresh and try again.</StatusMessage>
      ) : metrics.sampleCount === 0 ? (
        <p className="px-5 py-12 text-center text-[0.84rem] leading-relaxed text-muted-foreground group-[.is-padded]/panel:px-0 group-[.is-padded]/panel:py-5 group-[.is-padded]/panel:text-start [&_code]:text-foreground">
          No requests to this route in the selected range.
        </p>
      ) : (
        <>
          {metrics.windowTruncated && (
            <p className="mb-4 text-[0.85rem] text-muted-foreground">
              Older activity beyond the scan window is not included in these totals.
            </p>
          )}

          <KpiCards metrics={metrics} />

          <RequestBars buckets={metrics.buckets} tickLabel={tickLabel} />

          <div className="mt-9 [&>h3]:m-0 [&>h3]:mb-3 [&>h3]:flex [&>h3]:flex-wrap [&>h3]:items-baseline [&>h3]:gap-1.5 [&>h3]:text-[0.85rem] [&>h3]:font-semibold [&_h3_small]:font-normal [&_h3_small]:text-muted-foreground">
            <h3>Status codes</h3>
            <dl className="m-0 grid gap-2 [&>div]:grid [&>div]:grid-cols-[minmax(4.5rem,6rem)_minmax(0,1fr)_auto] [&>div]:items-center [&>div]:gap-x-3.5 [&_dd]:m-0 [&_dd]:contents [&_dt]:text-[0.75rem] [&_dt]:tabular-nums [&_dt]:text-muted-foreground [&_dt]:[overflow-wrap:anywhere]">
              {STATUS_ROWS.map((cls) => (
                <DistributionRow
                  key={cls}
                  label={cls}
                  value={metrics.statusDistribution[cls]}
                  total={metrics.sampleCount}
                  tone={cls}
                />
              ))}
            </dl>
          </div>

          <div className="mt-9 [&>h3]:m-0 [&>h3]:mb-3 [&>h3]:flex [&>h3]:flex-wrap [&>h3]:items-baseline [&>h3]:gap-1.5 [&>h3]:text-[0.85rem] [&>h3]:font-semibold [&_h3_small]:font-normal [&_h3_small]:text-muted-foreground">
            <h3>Latency</h3>
            {metrics.latencyMs ? (
              <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(7rem,8.5rem))] justify-start gap-x-8 gap-y-4 p-0 [&_span]:mt-0.5 [&_span]:block [&_span]:text-[0.72rem] [&_span]:text-muted-foreground [&_strong]:block [&_strong]:text-[1.35rem] [&_strong]:tracking-tight [&_strong]:tabular-nums">
                <li>
                  <strong>{group(metrics.latencyMs.p50)} ms</strong>
                  <span>p50</span>
                </li>
                <li>
                  <strong>{group(metrics.latencyMs.p90)} ms</strong>
                  <span>p90</span>
                </li>
                <li>
                  <strong>{group(metrics.latencyMs.p99)} ms</strong>
                  <span>p99</span>
                </li>
              </ul>
            ) : (
              <p className="px-5 py-12 text-center text-[0.84rem] leading-relaxed text-muted-foreground group-[.is-padded]/panel:px-0 group-[.is-padded]/panel:py-5 group-[.is-padded]/panel:text-start [&_code]:text-foreground">
                Not enough requests to compute latency percentiles.
              </p>
            )}
            <p className="mt-3 text-[0.75rem] text-muted-foreground">
              Nearest-rank percentiles over {group(metrics.sampleCount)} request{metrics.sampleCount === 1 ? "" : "s"}.
              The final bucket is still filling.
            </p>
          </div>

          {metrics.ttfbMs && (
            <div className="mt-9 [&>h3]:m-0 [&>h3]:mb-3 [&>h3]:flex [&>h3]:flex-wrap [&>h3]:items-baseline [&>h3]:gap-1.5 [&>h3]:text-[0.85rem] [&>h3]:font-semibold [&_h3_small]:font-normal [&_h3_small]:text-muted-foreground">
              <h3>
                Time to first byte <small>· edge → sprout response</small>
              </h3>
              <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(7rem,8.5rem))] justify-start gap-x-8 gap-y-4 p-0 [&_span]:mt-0.5 [&_span]:block [&_span]:text-[0.72rem] [&_span]:text-muted-foreground [&_strong]:block [&_strong]:text-[1.35rem] [&_strong]:tracking-tight [&_strong]:tabular-nums">
                <li>
                  <strong>{group(metrics.ttfbMs.p50)} ms</strong>
                  <span>p50</span>
                </li>
                <li>
                  <strong>{group(metrics.ttfbMs.p90)} ms</strong>
                  <span>p90</span>
                </li>
                <li>
                  <strong>{group(metrics.ttfbMs.p99)} ms</strong>
                  <span>p99</span>
                </li>
              </ul>
            </div>
          )}

          {metrics.cpuMs && (
            <div className="mt-9 [&>h3]:m-0 [&>h3]:mb-3 [&>h3]:flex [&>h3]:flex-wrap [&>h3]:items-baseline [&>h3]:gap-1.5 [&>h3]:text-[0.85rem] [&>h3]:font-semibold [&_h3_small]:font-normal [&_h3_small]:text-muted-foreground">
              <h3>
                CPU time <small>· per invocation</small>
              </h3>
              <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(7rem,8.5rem))] justify-start gap-x-8 gap-y-4 p-0 [&_span]:mt-0.5 [&_span]:block [&_span]:text-[0.72rem] [&_span]:text-muted-foreground [&_strong]:block [&_strong]:text-[1.35rem] [&_strong]:tracking-tight [&_strong]:tabular-nums">
                <li>
                  <strong>{group(metrics.cpuMs.p50)} ms</strong>
                  <span>p50</span>
                </li>
                <li>
                  <strong>{group(metrics.cpuMs.p90)} ms</strong>
                  <span>p90</span>
                </li>
                <li>
                  <strong>{group(metrics.cpuMs.p99)} ms</strong>
                  <span>p99</span>
                </li>
              </ul>
              <p className="mt-3 text-[0.75rem] text-muted-foreground">
                Worker CPU consumed by the handler, self-reported per request (sync and <code>async</code>). Responses
                with a streamed body or a <code>Set-Cookie</code> header are excluded, so this covers a subset of
                requests.
              </p>
            </div>
          )}

          <div className="mt-9 [&>h3]:m-0 [&>h3]:mb-3 [&>h3]:flex [&>h3]:flex-wrap [&>h3]:items-baseline [&>h3]:gap-1.5 [&>h3]:text-[0.85rem] [&>h3]:font-semibold [&_h3_small]:font-normal [&_h3_small]:text-muted-foreground">
            <h3>
              Cold starts <small>· spawn → listening</small>
            </h3>
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(7rem,8.5rem))] justify-start gap-x-8 gap-y-4 p-0 [&_span]:mt-0.5 [&_span]:block [&_span]:text-[0.72rem] [&_span]:text-muted-foreground [&_strong]:block [&_strong]:text-[1.35rem] [&_strong]:tracking-tight [&_strong]:tabular-nums">
              <li>
                <strong>{group(metrics.coldStarts)}</strong>
                <span>cold starts</span>
              </li>
              <li>
                <strong>
                  {metrics.sampleCount ? `${Math.round((metrics.coldStarts / metrics.sampleCount) * 100)}%` : "—"}
                </strong>
                <span>of requests</span>
              </li>
              <li>
                <strong>{metrics.startupMs ? `${group(metrics.startupMs.p50)} ms` : "—"}</strong>
                <span>startup p50</span>
              </li>
              <li>
                <strong>{metrics.startupMs ? `${group(metrics.startupMs.p90)} ms` : "—"}</strong>
                <span>startup p90</span>
              </li>
              <li>
                <strong>{metrics.bootMs ? `${group(metrics.bootMs.p50)} ms` : "—"}</strong>
                <span>boot p50</span>
              </li>
              <li>
                <strong>
                  {metrics.startupMs && metrics.bootMs
                    ? `${group(Math.max(0, metrics.startupMs.p50 - metrics.bootMs.p50))} ms`
                    : "—"}
                </strong>
                <span>eval p50</span>
              </li>
            </ul>
            <p className="mt-3 text-[0.75rem] text-muted-foreground">
              A cold start is a request that had to launch the sprout process (first hit after a deploy, crash, or idle
              eviction). <strong>boot</strong> is process create + <code>ld.so</code> + runtime init (static linking
              cuts this); <strong>eval</strong> is JS module evaluation + binding the listen socket (an inherited fd
              would cut this).
            </p>
          </div>

          <div className="mt-9 [&>h3]:m-0 [&>h3]:mb-3 [&>h3]:flex [&>h3]:flex-wrap [&>h3]:items-baseline [&>h3]:gap-1.5 [&>h3]:text-[0.85rem] [&>h3]:font-semibold [&_h3_small]:font-normal [&_h3_small]:text-muted-foreground">
            <h3>Transfer</h3>
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(7rem,8.5rem))] justify-start gap-x-8 gap-y-4 p-0 [&_span]:mt-0.5 [&_span]:block [&_span]:text-[0.72rem] [&_span]:text-muted-foreground [&_strong]:block [&_strong]:text-[1.35rem] [&_strong]:tracking-tight [&_strong]:tabular-nums">
              <li>
                <strong>{bytes(metrics.bytesIn)}</strong>
                <span>request body in</span>
              </li>
              <li>
                <strong>{bytes(metrics.bytesOut)}</strong>
                <span>response body out</span>
              </li>
            </ul>
            <p className="mt-3 text-[0.75rem] text-muted-foreground">
              Body bytes only, from Content-Length; streamed responses without a length are not counted.
            </p>
          </div>

          {Object.keys(metrics.invocationStatus).some((key) => key !== "ok") && (
            <div className="mt-9 [&>h3]:m-0 [&>h3]:mb-3 [&>h3]:flex [&>h3]:flex-wrap [&>h3]:items-baseline [&>h3]:gap-1.5 [&>h3]:text-[0.85rem] [&>h3]:font-semibold [&_h3_small]:font-normal [&_h3_small]:text-muted-foreground">
              <h3>Invocation status</h3>
              <dl className="m-0 grid gap-2 [&>div]:grid [&>div]:grid-cols-[minmax(4.5rem,6rem)_minmax(0,1fr)_auto] [&>div]:items-center [&>div]:gap-x-3.5 [&_dd]:m-0 [&_dd]:contents [&_dt]:text-[0.75rem] [&_dt]:tabular-nums [&_dt]:text-muted-foreground [&_dt]:[overflow-wrap:anywhere]">
                {Object.entries(metrics.invocationStatus)
                  .sort((a, b) => b[1] - a[1])
                  .map(([status, value]) => (
                    <DistributionRow
                      key={status}
                      label={status}
                      value={value}
                      total={metrics.sampleCount}
                      tone={status === "ok" ? "2xx" : "5xx"}
                    />
                  ))}
              </dl>
              <p className="mt-3 text-[0.75rem] text-muted-foreground">
                `timed-out` and `response-too-large` are platform caps (#27); `sprout-unavailable` / `proxy` are runtime
                failures.
              </p>
            </div>
          )}

          {Object.keys(metrics.methodDistribution).length > 0 && (
            <div className="mt-9 [&>h3]:m-0 [&>h3]:mb-3 [&>h3]:flex [&>h3]:flex-wrap [&>h3]:items-baseline [&>h3]:gap-1.5 [&>h3]:text-[0.85rem] [&>h3]:font-semibold [&_h3_small]:font-normal [&_h3_small]:text-muted-foreground">
              <h3>Methods</h3>
              <dl className="m-0 grid gap-2 [&>div]:grid [&>div]:grid-cols-[minmax(4.5rem,6rem)_minmax(0,1fr)_auto] [&>div]:items-center [&>div]:gap-x-3.5 [&_dd]:m-0 [&_dd]:contents [&_dt]:text-[0.75rem] [&_dt]:tabular-nums [&_dt]:text-muted-foreground [&_dt]:[overflow-wrap:anywhere]">
                {Object.entries(metrics.methodDistribution)
                  .sort((a, b) => b[1] - a[1])
                  .map(([method, value]) => (
                    <DistributionRow key={method} label={method} value={value} total={metrics.sampleCount} />
                  ))}
              </dl>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

/** One stacked bar per time bucket: errors solid at the base, successes above.
 *  The split is read by height, which a hatch fill over the same bar is not.
 *
 *  `focusGroupX` gives the whole bucket to one hover, so the tooltip reports
 *  requests and errors together instead of whichever rect the pointer landed
 *  on, and the host portals the tooltip out of the overflow-x-auto scroller
 *  that would otherwise clip it. Keyboard users get the same points: arrows
 *  walk the buckets, Enter pins, Escape dismisses. */
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
    return buckets
      .filter((bucket) => {
        const label = tickLabel(bucket.start);
        if (seen.has(label)) return false;
        seen.add(label);
        return true;
      })
      .map((bucket) => bucket.start);
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
              // The palette stays in the dashboard's tokens rather than moving
              // into --ts-chart-*, so the theme flip keeps owning it.
              fill: (row: BarRow) => (row.series === "errors" ? "var(--coral)" : "var(--muted)"),
              layout: stack(),
            }),
          ],
          scales: {
            x: {
              scale: scaleBand,
              // Without a format the band scale labels every bucket with its raw
              // ISO start. `thin` then drops whatever would still collide, so
              // this reads across the axis instead of only at the two ends.
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
    <div className="mt-9 [&>h3]:m-0 [&>h3]:mb-3 [&>h3]:flex [&>h3]:flex-wrap [&>h3]:items-baseline [&>h3]:gap-1.5 [&>h3]:text-[0.85rem] [&>h3]:font-semibold [&_h3_small]:font-normal [&_h3_small]:text-muted-foreground">
      <h3>
        Requests <small>· peak {group(max)}/bucket</small>
      </h3>
      <Chart
        definition={definition}
        ariaLabel={`Requests per time bucket, peak ${max}`}
        height={96}
        className="block w-full"
        renderTooltipBody={({ points }) => {
          const first = points[0]?.datum;
          if (!first) return null;
          const bucket = buckets.find((candidate) => candidate.start === first.start);
          if (!bucket) return null;
          return (
            <div className="grid gap-0.5 text-[0.75rem] tabular-nums">
              <span className="text-muted-foreground">{tickLabel(bucket.start)}</span>
              <span>
                {group(bucket.count)} request{bucket.count === 1 ? "" : "s"}
              </span>
              <span className={bucket.errors > 0 ? "text-coral" : "text-muted-foreground"}>
                {group(bucket.errors)} error{bucket.errors === 1 ? "" : "s"}
              </span>
            </div>
          );
        }}
      />
      <p className="mt-2 flex items-center gap-1.5 text-[0.72rem] text-muted-foreground">
        <span className="inline-block size-[0.7rem] bg-muted-foreground" /> requests{" "}
        <span className="inline-block size-[0.7rem] bg-coral" /> 5xx errors
      </p>
    </div>
  );
}
