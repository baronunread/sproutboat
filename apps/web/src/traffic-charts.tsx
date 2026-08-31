import { useCallback, useEffect, useState } from "react";

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
  ["1h", "1 hour"], ["6h", "6 hours"], ["24h", "24 hours"], ["7d", "7 days"],
];
const STATUS_ROWS: readonly StatusClass[] = ["2xx", "3xx", "4xx", "5xx", "other"];
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const group = (value: number) => value.toLocaleString();

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
    <svg className="metric-spark" viewBox="0 0 100 20" preserveAspectRatio="none" role="img" aria-hidden="true">
      <polyline points={points} fill="none" stroke="var(--sky)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** #37: KPI card — value, delta chip vs the previous same-length window, sparkline. */
function MetricCard({ title, value, delta, goodWhen = "up", spark }: {
  title: string; value: string; delta: number | null; goodWhen?: "up" | "down"; spark?: number[];
}) {
  const dir = delta === null || Math.abs(delta) < 0.5 ? "flat" : delta > 0 ? "up" : "down";
  const tone = dir === "flat" ? "flat" : (dir === "up") === (goodWhen === "up") ? "up" : "down";
  return (
    <div className="metric-card">
      <span className="metric-title">{title}</span>
      <span className="metric-value">{value}</span>
      <span className={`metric-delta ${tone}`}>
        {delta === null ? "— no prior data" : `${delta > 0 ? "↑" : delta < 0 ? "↓" : ""} ${Math.abs(delta).toFixed(1)}% vs prev`}
      </span>
      {spark && spark.length > 1 && <Sparkline values={spark} />}
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

          {(() => {
            const requests = metrics.buckets.reduce((sum, b) => sum + b.count, 0);
            const errors = metrics.buckets.reduce((sum, b) => sum + b.errors, 0);
            const errRate = requests ? (errors / requests) * 100 : 0;
            const prevErrRate = metrics.previous.requests ? (metrics.previous.errors / metrics.previous.requests) * 100 : 0;
            return (
              <div className="metric-cards">
                <MetricCard title="Requests" value={group(requests)} delta={deltaPct(requests, metrics.previous.requests)} goodWhen="up" spark={metrics.buckets.map((b) => b.count)} />
                <MetricCard title="Error rate" value={`${errRate.toFixed(1)}%`} delta={deltaPct(errRate, prevErrRate)} goodWhen="down" spark={metrics.buckets.map((b) => b.errors)} />
                <MetricCard title="Latency p50" value={metrics.latencyMs ? `${group(metrics.latencyMs.p50)} ms` : "—"} delta={metrics.latencyMs && metrics.previous.latencyP50 !== null ? deltaPct(metrics.latencyMs.p50, metrics.previous.latencyP50) : null} goodWhen="down" />
                <MetricCard title="Cache hit rate" value={metrics.cacheHitRate === null ? "—" : `${metrics.cacheHitRate.toFixed(1)}%`} delta={null} goodWhen="up" />
                <MetricCard title="Cold starts" value={group(metrics.coldStarts)} delta={null} goodWhen="down" spark={metrics.buckets.map((b) => b.coldStarts)} />
              </div>
            );
          })()}

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

          {metrics.ttfbMs && (
            <div className="chart-block">
              <h3>Time to first byte <small>· edge → worker response</small></h3>
              <ul className="latency-tiles">
                <li><strong>{group(metrics.ttfbMs.p50)} ms</strong><span>p50</span></li>
                <li><strong>{group(metrics.ttfbMs.p90)} ms</strong><span>p90</span></li>
                <li><strong>{group(metrics.ttfbMs.p99)} ms</strong><span>p99</span></li>
              </ul>
            </div>
          )}

          <div className="chart-block">
            <h3>Cold starts <small>· spawn → listening</small></h3>
            <ul className="latency-tiles">
              <li><strong>{group(metrics.coldStarts)}</strong><span>cold starts</span></li>
              <li><strong>{metrics.sampleCount ? `${Math.round((metrics.coldStarts / metrics.sampleCount) * 100)}%` : "—"}</strong><span>of requests</span></li>
              <li><strong>{metrics.startupMs ? `${group(metrics.startupMs.p50)} ms` : "—"}</strong><span>startup p50</span></li>
              <li><strong>{metrics.startupMs ? `${group(metrics.startupMs.p90)} ms` : "—"}</strong><span>startup p90</span></li>
              <li><strong>{metrics.bootMs ? `${group(metrics.bootMs.p50)} ms` : "—"}</strong><span>boot p50 · process + runtime</span></li>
              <li>
                <strong>{metrics.startupMs && metrics.bootMs ? `${group(Math.max(0, metrics.startupMs.p50 - metrics.bootMs.p50))} ms` : "—"}</strong>
                <span>eval p50 · module + bind</span>
              </li>
            </ul>
            <p className="hint">A cold start is a request that had to launch the worker process (first hit after a deploy, crash, or idle eviction). <strong>boot</strong> is process create + <code>ld.so</code> + runtime init (static linking cuts this); <strong>eval</strong> is JS module evaluation + binding the listen socket (an inherited fd would cut this).</p>
          </div>

          <div className="chart-block">
            <h3>Transfer</h3>
            <ul className="latency-tiles">
              <li><strong>{bytes(metrics.bytesIn)}</strong><span>request body in</span></li>
              <li><strong>{bytes(metrics.bytesOut)}</strong><span>response body out</span></li>
            </ul>
            <p className="hint">Body bytes only, from Content-Length; streamed responses without a length are not counted.</p>
          </div>

          {Object.keys(metrics.invocationStatus).some((key) => key !== "ok") && (
            <div className="chart-block">
              <h3>Invocation status</h3>
              <dl className="status-bars">
                {Object.entries(metrics.invocationStatus).sort((a, b) => b[1] - a[1]).map(([status, value]) => {
                  const width = metrics.sampleCount ? Math.round((value / metrics.sampleCount) * 100) : 0;
                  const cls = status === "ok" ? "2xx" : "5xx";
                  return (
                    <div key={status}>
                      <dt>{status}</dt>
                      <dd><span className={`status-bar status-bar-${cls}`} style={{ width: `${width}%` }} aria-hidden="true" />{group(value)} <small>({width}%)</small></dd>
                    </div>
                  );
                })}
              </dl>
              <p className="hint">`timed-out` and `response-too-large` are platform caps (#27); `worker-unavailable` / `proxy` are runtime failures.</p>
            </div>
          )}

          {Object.keys(metrics.methodDistribution).length > 0 && (
            <div className="chart-block">
              <h3>Methods</h3>
              <dl className="status-bars">
                {Object.entries(metrics.methodDistribution).sort((a, b) => b[1] - a[1]).map(([method, value]) => {
                  const width = metrics.sampleCount ? Math.round((value / metrics.sampleCount) * 100) : 0;
                  return (
                    <div key={method}>
                      <dt>{method}</dt>
                      <dd><span className="status-bar status-bar-2xx" style={{ width: `${width}%` }} aria-hidden="true" />{group(value)} <small>({width}%)</small></dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          )}
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
