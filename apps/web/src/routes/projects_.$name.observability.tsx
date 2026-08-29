import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { relativeTime, useProject } from "../dashboard-data";
import { TrafficCharts } from "../traffic-charts";

export const Route = createFileRoute("/projects_/$name/observability")({ component: ProjectObservability });

type StatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "other";
type LogRecord = { at: string; status: number; durationMs: number; failure: string | null; statusClass: StatusClass };
type LogPage = { events: LogRecord[]; nextBefore: string | null; windowTruncated: boolean };
type TailFrame = { type: "ready" | "event" | "closed"; event?: LogRecord; reason?: string };
type Row = { key: number; record: LogRecord; title: string };

const FULL_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

const STATUS_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["all", "All statuses"], ["2xx", "2xx"], ["3xx", "3xx"], ["4xx", "4xx"], ["5xx", "5xx"], ["other", "Other"],
];
const MAX_ROWS = 500;

function ProjectObservability() {
  const { name, active } = useProject();
  const [statusClass, setStatusClass] = useState("all");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [tailing, setTailing] = useState(false);
  const [tailNote, setTailNote] = useState("");
  const nextKey = useRef(0);

  const wrap = useCallback((records: LogRecord[]): Row[] =>
    records.map((record) => ({ key: nextKey.current++, record, title: FULL_TIME.format(new Date(record.at)) })), []);

  const historyUrl = useCallback((before?: string) => {
    const params = new URLSearchParams({ limit: "100" });
    if (statusClass !== "all") params.set("status", statusClass);
    if (query.trim()) params.set("q", query.trim());
    if (before) params.set("before", before);
    return `/api/projects/${encodeURIComponent(name)}/logs?${params.toString()}`;
  }, [name, statusClass, query]);

  const matches = useCallback((record: LogRecord) => {
    if (statusClass !== "all" && record.statusClass !== statusClass) return false;
    const needle = query.trim().toLowerCase();
    return !needle || `${record.status} ${record.failure ?? ""}`.toLowerCase().includes(needle);
  }, [statusClass, query]);
  const matchesRef = useRef(matches);
  useEffect(() => { matchesRef.current = matches; }, [matches]);

  const loadFirst = useCallback(async () => {
    setState("loading");
    try {
      const response = await fetch(historyUrl(), { credentials: "include" });
      if (!response.ok) { setState("error"); return; }
      // SAFETY: a 2xx from the log-history endpoint is the LogPage contract.
      const page = await response.json() as LogPage;
      setRows(wrap(page.events)); setNextBefore(page.nextBefore); setTruncated(page.windowTruncated); setState("ready");
    } catch { setState("error"); }
  }, [historyUrl, wrap]);

  const loadOlder = async () => {
    if (!nextBefore) return;
    try {
      const response = await fetch(historyUrl(nextBefore), { credentials: "include" });
      if (!response.ok) return;
      // SAFETY: a 2xx from the log-history endpoint is the LogPage contract.
      const page = await response.json() as LogPage;
      const older = wrap(page.events);
      setRows((current) => [...current, ...older]);
      setNextBefore(page.nextBefore);
    } catch { /* keep the button for a retry */ }
  };

  useEffect(() => { void loadFirst(); }, [loadFirst]);

  // The live tail's whole lifecycle is this effect: it opens the stream while
  // `tailing` is on and closes it on toggle-off, section change, or unmount.
  useEffect(() => {
    if (!tailing) return;
    setTailNote("");
    const stream = new EventSource(`/api/projects/${encodeURIComponent(name)}/logs/tail`);
    stream.onmessage = (message) => {
      // SAFETY: the tail endpoint sends one TailFrame JSON object per message.
      const frame = JSON.parse(message.data) as TailFrame;
      const record = frame.event;
      if (frame.type === "event" && record) {
        if (matchesRef.current(record)) {
          const row = { key: nextKey.current++, record, title: FULL_TIME.format(new Date(record.at)) };
          setRows((current) => [row, ...current].slice(0, MAX_ROWS));
        }
      } else if (frame.type === "closed") {
        setTailNote(frame.reason ?? "Live tail ended.");
        setTailing(false);
      }
    };
    stream.onerror = () => { setTailNote("Live tail disconnected. Resume to reconnect."); setTailing(false); };
    return () => stream.close();
  }, [tailing, name]);

  return (
    <>
    <TrafficCharts name={name} />
    <section className="data-panel settings-panel">
      <div className="panel-heading"><div><h2>Request logs</h2><p>Edge events for this project's route, newest first.</p></div></div>

      {!active && <p className="form-status">This project has no active route right now — only past traffic is shown.</p>}

      <div className="log-filters">
        <select aria-label="Filter by status class" value={statusClass} onChange={(event) => setStatusClass(event.target.value)}>
          {STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <input aria-label="Filter log text" placeholder="Match status or failure text" value={query}
          onChange={(event) => setQuery(event.target.value)} />
        <button type="button" className={tailing ? "button danger" : "button quiet"}
          onClick={() => setTailing((on) => !on)}>
          {tailing ? "Stop live tail" : "Start live tail"}
        </button>
        <span className={tailing ? "tail-state live" : "tail-state"}>{tailing ? "Live" : "Paused"}</span>
      </div>

      {tailNote && <p className="form-status" role="status">{tailNote}</p>}
      {truncated && <p className="form-status">Showing the most recent window of activity; older history is not retained here.</p>}

      {state === "loading" ? (
        <p className="loading-state" aria-live="polite">Loading events…</p>
      ) : state === "error" ? (
        <p className="form-error" role="alert">Could not load logs. Refresh and try again.</p>
      ) : rows.length === 0 ? (
        <p className="empty-state">No requests recorded for this route yet.</p>
      ) : (
        <>
          <div className="log-scroll">
            <table className="log-table">
              <thead>
                <tr><th scope="col">Time</th><th scope="col">Status</th><th scope="col">Duration</th><th scope="col">Failure</th></tr>
              </thead>
              <tbody>
                {rows.map(({ key, record, title }) => (
                  <tr key={key}>
                    <td title={title}>{relativeTime(record.at)}</td>
                    <td className={`log-status log-${record.statusClass}`}>{record.status}</td>
                    <td>{record.durationMs} ms</td>
                    <td>{record.failure ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {nextBefore && !tailing && (
            <button type="button" className="button quiet" onClick={() => void loadOlder()}>Load older</button>
          )}
        </>
      )}
    </section>
    </>
  );
}
