import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button, DataTable, Panel, PanelHeading, SelectField, StatusMessage, TextField } from "../components";
import { relativeTime, useProject } from "../dashboard-data";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/projects_/$name/logs")({ component: ProjectLogs });

type StatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "other";
type LogRecord = {
  at: string; method: string | null; status: number; durationMs: number;
  coldStart: boolean; cacheStatus: string | null; failure: string | null; statusClass: StatusClass;
};
type LogPage = { events: LogRecord[]; nextBefore: string | null; windowTruncated: boolean };
type TailFrame = { type: "ready" | "event" | "closed"; event?: LogRecord; reason?: string };
type Row = { key: number; record: LogRecord; title: string };

const LOG_STATUS = {
  "2xx": "text-success", "3xx": "text-sky", "4xx": "text-coral", "5xx": "text-coral", other: "",
} satisfies Record<StatusClass, string>;

const FULL_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

const STATUS_OPTIONS = [
  ["all", "All statuses"], ["2xx", "2xx"], ["3xx", "3xx"], ["4xx", "4xx"], ["5xx", "5xx"], ["other", "Other"],
] as const;
const METHOD_OPTIONS = [
  ["all", "All methods"], ["GET", "GET"], ["POST", "POST"], ["PUT", "PUT"], ["PATCH", "PATCH"], ["DELETE", "DELETE"], ["HEAD", "HEAD"],
] as const;
const DURATION_OPTIONS = [
  ["0", "Any duration"], ["100", "Slower than 100 ms"], ["500", "Slower than 500 ms"], ["1000", "Slower than 1 s"],
] as const;
const COLD_OPTIONS = [["all", "All requests"], ["true", "Cold starts only"]] as const;
const MAX_ROWS = 500;

type Filters = { statusClass: string; method: string; minDuration: string; coldStart: string; query: string };
const EMPTY: Filters = { statusClass: "all", method: "all", minDuration: "0", coldStart: "all", query: "" };

function ProjectLogs() {
  const { name, active } = useProject();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [rows, setRows] = useState<Row[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [tailing, setTailing] = useState(false);
  const [tailNote, setTailNote] = useState("");
  const nextKey = useRef(0);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((current) => ({ ...current, [key]: value }));
  const filtered = filters.statusClass !== "all" || filters.method !== "all" || filters.minDuration !== "0"
    || filters.coldStart !== "all" || filters.query.trim() !== "";

  const wrap = useCallback((records: LogRecord[]): Row[] =>
    records.map((record) => ({ key: nextKey.current++, record, title: FULL_TIME.format(new Date(record.at)) })), []);

  const historyUrl = useCallback((before?: string) => {
    const params = new URLSearchParams({ limit: "100" });
    if (filters.statusClass !== "all") params.set("status", filters.statusClass);
    if (filters.method !== "all") params.set("method", filters.method);
    if (filters.minDuration !== "0") params.set("minDuration", filters.minDuration);
    if (filters.coldStart === "true") params.set("coldStart", "true");
    if (filters.query.trim()) params.set("q", filters.query.trim());
    if (before) params.set("before", before);
    return `/api/projects/${encodeURIComponent(name)}/logs?${params.toString()}`;
  }, [name, filters]);

  // The live tail is unfiltered on the wire, so the same predicate is applied
  // client-side to incoming frames — otherwise a filtered view would fill with
  // rows that the history call would never have returned.
  const matches = useCallback((record: LogRecord) => {
    if (filters.statusClass !== "all" && record.statusClass !== filters.statusClass) return false;
    if (filters.method !== "all" && record.method?.toUpperCase() !== filters.method) return false;
    if (Number(filters.minDuration) > 0 && record.durationMs < Number(filters.minDuration)) return false;
    if (filters.coldStart === "true" && !record.coldStart) return false;
    const needle = filters.query.trim().toLowerCase();
    return !needle || `${record.status} ${record.method ?? ""} ${record.failure ?? ""}`.toLowerCase().includes(needle);
  }, [filters]);
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
      setRows((current) => [...current, ...wrap(page.events)]);
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
      <Panel variant="wide">
        <PanelHeading
          title="Request logs"
          description="Edge events for this project's route, newest first."
          action={
            <div data-slot="form-actions" className="mt-1 flex flex-wrap items-center gap-2.5">
              <span className={cn("text-[0.75rem]", tailing ? "text-brand before:mr-1.5 before:inline-block before:size-1.5 before:rounded-full before:bg-brand before:content-['']" : "text-muted-foreground")}>{tailing ? "Live" : "Paused"}</span>
              <Button variant={tailing ? "danger" : "quiet"} onClick={() => setTailing((on) => !on)}>
                {tailing ? "Stop live tail" : "Start live tail"}
              </Button>
            </div>
          }
        />

        {!active && <StatusMessage>This project has no active route right now — only past traffic is shown.</StatusMessage>}

        <search className="mt-5 mb-3 flex flex-wrap items-end gap-2.5">
          <SelectField label="Status" value={filters.statusClass} options={STATUS_OPTIONS}
            onValueChange={(value) => set("statusClass", value)} />
          <SelectField label="Method" value={filters.method} options={METHOD_OPTIONS}
            onValueChange={(value) => set("method", value)} />
          <SelectField label="Duration" value={filters.minDuration} options={DURATION_OPTIONS}
            onValueChange={(value) => set("minDuration", value)} />
          <SelectField label="Cold start" value={filters.coldStart} options={COLD_OPTIONS}
            onValueChange={(value) => set("coldStart", value)} />
          <TextField label="Search" type="search" fieldClassName="min-w-0 flex-[1_1_16rem]" placeholder="Match status, method, or failure text"
            value={filters.query} onChange={(event) => set("query", event.target.value)} />
          <Button variant="quiet" disabled={!filtered} onClick={() => setFilters(EMPTY)}>Clear</Button>
        </search>

        {tailNote && <StatusMessage>{tailNote}</StatusMessage>}
        {truncated && <StatusMessage>Showing the most recent window of activity; older history is not retained here.</StatusMessage>}

        {state === "loading" ? (
          <p className="min-h-56 px-5 pt-12 text-muted-foreground group-[.is-padded]/panel:px-0" aria-live="polite">Loading events…</p>
        ) : state === "error" ? (
          <StatusMessage tone="error">Could not load logs. Refresh and try again.</StatusMessage>
        ) : rows.length === 0 ? (
          <p className="px-5 py-12 text-center text-[0.84rem] leading-relaxed text-muted-foreground group-[.is-padded]/panel:px-0 group-[.is-padded]/panel:py-5 group-[.is-padded]/panel:text-start [&_code]:text-foreground">{filtered ? "No requests match these filters." : "No requests recorded for this route yet."}</p>
        ) : (
          <>
            <DataTable caption="Request log, newest first"
              head={<tr>
                    <th scope="col">Time</th><th scope="col">Method</th><th scope="col" className="text-end tabular-nums">Status</th>
                    <th scope="col" className="text-end tabular-nums">Duration</th><th scope="col">Start</th><th scope="col">Failure</th>
                  </tr>}
            >
              {rows.map(({ key, record, title }) => (
                    <tr key={key}>
                      <td title={title}>{relativeTime(record.at)}</td>
                      <td>{record.method ?? "—"}</td>
                      <td className={cn("text-end font-semibold tabular-nums", LOG_STATUS[record.statusClass])}>{record.status}</td>
                      <td className="text-end tabular-nums">{record.durationMs} ms</td>
                      <td>{record.coldStart ? <span className="badge">Cold</span> : "Warm"}</td>
                      <td>{record.failure ?? "—"}</td>
                    </tr>
                  ))}
            </DataTable>
            {nextBefore && !tailing && (
              <div data-slot="form-actions" className="mt-1 flex flex-wrap items-center gap-2.5">
                <Button variant="quiet" onClick={() => void loadOlder()}>Load older</Button>
              </div>
            )}
          </>
        )}
      </Panel>

      <SproutOutput name={name} />
    </>
  );
}

/**
 * #76 — stdout/stderr of the running sprout + its binding broker. This is where
 * a handler's console output and its crash traces land; before this panel the
 * only way to read them was `sproutboat tail --sprout`.
 */
function SproutOutput({ name }: { name: string }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "ready" | "missing" | "error">("idle");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(name)}/logs/sprout`, { credentials: "include" });
      if (response.status === 404) { setState("missing"); return; }
      if (!response.ok) { setState("error"); return; }
      setText(await response.text());
      setState("ready");
    } catch { setState("error"); }
  }, [name]);
  useEffect(() => { void load(); }, [load]);

  return (
    <Panel variant="wide">
      <PanelHeading
        title="Sprout output"
        description="stdout and stderr from the active version's process and its binding broker."
        action={<Button variant="quiet" busy={state === "loading"} busyLabel="Refreshing…" onClick={() => void load()}>Refresh</Button>}
      />
      {state === "missing" ? (
        <p className="px-5 py-12 text-center text-[0.84rem] leading-relaxed text-muted-foreground group-[.is-padded]/panel:px-0 group-[.is-padded]/panel:py-5 group-[.is-padded]/panel:text-start [&_code]:text-foreground">No active deployment, so nothing is running to produce output.</p>
      ) : state === "error" ? (
        <StatusMessage tone="error">Could not read the sprout log. Refresh and try again.</StatusMessage>
      ) : state === "ready" ? (
        <pre className="mt-5 max-h-[26rem] overflow-auto rounded-md border border-border bg-background p-4 font-mono text-[0.76rem] leading-relaxed break-words whitespace-pre-wrap focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none" tabIndex={0} aria-label="Sprout process output">{text}</pre>
      ) : (
        <p className="min-h-56 px-5 pt-12 text-muted-foreground group-[.is-padded]/panel:px-0" aria-live="polite">Loading output…</p>
      )}
    </Panel>
  );
}
