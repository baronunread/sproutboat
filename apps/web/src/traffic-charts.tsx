import { useCallback, useEffect, useState } from "react";

type StatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "other";
type Bucket = { start: string; count: number; errors: number };
type Metrics = {
  range: string;
  from: string;
  to: string;
  bucketMs: number;
  buckets: Bucket[];
  statusDistribution: Record<StatusClass, number>;
  latencyMs: { p50: number; p90: number; p99: number } | null;
  sampleCount: number;
  windowTruncated: boolean;
};

const RANGES: ReadonlyArray<readonly [string, string]> = [
  ["1h", "1 hour"], ["6h", "6 hours"], ["24h", "24 hours"], ["7d", "7 days"],
];
const STATUS_ROWS: readonly StatusClass[] = ["2xx", "3xx", "4xx", "5xx", "other"];
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const group = (value: number) => value.toLocaleString();

/** #10: request/error time series, status distribution, and latency percentiles for one project. */
export function TrafficCharts({ name }: { name: string }) {
  const [range, setRange] = useState("24h");
  const [metrics, setMetrics] = useState<Metrics>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(name)}/metrics?range=${range}`, { credentials: "include" });
      if (!response.ok) { setState("error"); return; }
      // SAFETY: a 2xx from the metrics endpoint is the Metrics contract.
      setMetrics(await response.json() as Metrics);
      setState("ready");
    } catch { setState("error"); }
  }, [name, range]);
  useEffect(() => { void load(); }, [load]);

  const wide = range === "7d";
  const tickLabel = (iso: string) => (wide ? DAY : CLOCK).format(new Date(iso));

  return (
    <section className="data-panel settings-panel">
      <div className="panel-heading">
        <div><h2>Traffic</h2><p>Aggregated from edge request logs. Coarse buckets over a bounded scan — not a metrics platform.</p></div>
        <select aria-label="Chart time range" value={range} onChange={(event) => setRange(event.target.value)}>
          {RANGES.map(([value, label]) => <option key={value} value={value}>Last {label}</option>)}
        </select>
      </div>

      {state === "loading" ? (
        <p className="loading-state" aria-live="polite">Loading traffic…</p>
      ) : state === "error" || !metrics ? (
        <p className="form-error" role="alert">Could not load traffic. Refresh and try again.</p>
      ) : metrics.sampleCount === 0 ? (
        <p className="empty-state">No requests to this route in the selected range.</p>
      ) : (
        <>
          {metrics.windowTruncated && <p className="form-status">Older activity beyond the scan window is not included in these totals.</p>}

          <RequestBars buckets={metrics.buckets} tickLabel={tickLabel} />

          <div className="chart-block">
            <h3>Status codes</h3>
            <dl className="status-bars">
              {STATUS_ROWS.map((cls) => {
                const value = metrics.statusDistribution[cls];
                const width = metrics.sampleCount ? Math.round((value / metrics.sampleCount) * 100) : 0;
                return (
                  <div key={cls}>
                    <dt>{cls}</dt>
                    <dd><span className={`status-bar status-bar-${cls}`} style={{ width: `${width}%` }} aria-hidden="true" />{group(value)} <small>({width}%)</small></dd>
                  </div>
                );
              })}
            </dl>
          </div>

          <div className="chart-block">
            <h3>Latency</h3>
            {metrics.latencyMs ? (
              <ul className="latency-tiles">
                <li><strong>{group(metrics.latencyMs.p50)} ms</strong><span>p50</span></li>
                <li><strong>{group(metrics.latencyMs.p90)} ms</strong><span>p90</span></li>
                <li><strong>{group(metrics.latencyMs.p99)} ms</strong><span>p99</span></li>
                <li><strong>{group(metrics.sampleCount)}</strong><span>requests</span></li>
              </ul>
            ) : <p className="empty-state">Not enough requests to compute latency percentiles.</p>}
            <p className="hint">Nearest-rank percentiles over {group(metrics.sampleCount)} request{metrics.sampleCount === 1 ? "" : "s"}. The final bucket is still filling.</p>
          </div>
        </>
      )}
    </section>
  );
}

function RequestBars({ buckets, tickLabel }: { buckets: Bucket[]; tickLabel: (iso: string) => string }) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const step = 10;
  const gap = 2;
  const height = 80;
  const width = buckets.length * step;
  return (
    <div className="chart-block">
      <h3>Requests <small>· peak {group(max)}/bucket</small></h3>
      <div className="bars-scroll">
        <svg className="bars" viewBox={`0 0 ${width} ${height + 16}`} preserveAspectRatio="none" role="img"
          aria-label={`Requests per time bucket, peak ${max}`}>
          <defs>
            <pattern id="errhatch" width="4" height="4" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
              <rect width="4" height="4" fill="var(--panel-2)" />
              <line x1="0" y1="0" x2="0" y2="4" stroke="var(--coral)" strokeWidth="2.5" />
            </pattern>
          </defs>
          {buckets.map((bucket, index) => {
            const barHeight = Math.round((bucket.count / max) * height);
            const errHeight = Math.round((bucket.errors / max) * height);
            const x = index * step;
            return (
              <g key={bucket.start}>
                <title>{`${tickLabel(bucket.start)} — ${bucket.count} request${bucket.count === 1 ? "" : "s"}, ${bucket.errors} error${bucket.errors === 1 ? "" : "s"}`}</title>
                <rect x={x} y={height - barHeight} width={step - gap} height={barHeight} fill="var(--muted)" />
                {errHeight > 0 && <rect x={x} y={height - errHeight} width={step - gap} height={errHeight} fill="url(#errhatch)" />}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="bars-axis"><span>{tickLabel(buckets[0].start)}</span><span>{tickLabel(buckets[buckets.length - 1].start)}</span></div>
      <p className="chart-legend"><span className="swatch swatch-total" /> requests <span className="swatch swatch-error" /> 5xx errors</p>
    </div>
  );
}
