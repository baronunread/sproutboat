import {
  Banner,
  Button,
  CodeBlock,
  EmptyState,
  Field,
  Input,
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from "@sproutboat/ikada";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { relativeTime, useProject } from "../dashboard-data";
import { LiveTail } from "../live-tail";
import { statusTone } from "../log-row";
import { FilterSelect, LoadingLine, Section } from "../project-ui";

export const Route = createFileRoute("/projects_/$name/logs")({ component: ProjectLogs });

type StatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "other";
type LogRecord = {
  at: string;
  method: string | null;
  status: number;
  durationMs: number;
  coldStart: boolean;
  cacheStatus: string | null;
  failure: string | null;
  statusClass: StatusClass;
};
type LogPage = { events: LogRecord[]; nextBefore: string | null; windowTruncated: boolean };
type Row = { key: number; record: LogRecord; title: string };

const STATUS_TEXT = {
  ok: "text-brand-fg",
  info: "text-info-fg",
  danger: "text-danger-fg",
  warn: "text-warn-fg",
  default: "text-fg",
} as const;

const FULL_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "2xx", label: "2xx" },
  { value: "3xx", label: "3xx" },
  { value: "4xx", label: "4xx" },
  { value: "5xx", label: "5xx" },
  { value: "other", label: "Other" },
];
const METHOD_OPTIONS = [
  { value: "all", label: "All methods" },
  { value: "GET", label: "GET" },
  { value: "POST", label: "POST" },
  { value: "PUT", label: "PUT" },
  { value: "PATCH", label: "PATCH" },
  { value: "DELETE", label: "DELETE" },
  { value: "HEAD", label: "HEAD" },
];
const DURATION_OPTIONS = [
  { value: "0", label: "Any duration" },
  { value: "100", label: "Slower than 100 ms" },
  { value: "500", label: "Slower than 500 ms" },
  { value: "1000", label: "Slower than 1 s" },
];
const COLD_OPTIONS = [
  { value: "all", label: "All requests" },
  { value: "true", label: "Cold starts only" },
];

type Filters = { statusClass: string; method: string; minDuration: string; coldStart: string; query: string };
const EMPTY: Filters = { statusClass: "all", method: "all", minDuration: "0", coldStart: "all", query: "" };

function ProjectLogs() {
  const { name, active } = useProject();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [rows, setRows] = useState<Row[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const nextKey = useRef(0);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));
  const filtered =
    filters.statusClass !== "all" ||
    filters.method !== "all" ||
    filters.minDuration !== "0" ||
    filters.coldStart !== "all" ||
    filters.query.trim() !== "";

  const wrap = useCallback(
    (records: LogRecord[]): Row[] =>
      records.map((record) => ({ key: nextKey.current++, record, title: FULL_TIME.format(new Date(record.at)) })),
    [],
  );

  const historyUrl = useCallback(
    (before?: string) => {
      const params = new URLSearchParams({ limit: "100" });
      if (filters.statusClass !== "all") params.set("status", filters.statusClass);
      if (filters.method !== "all") params.set("method", filters.method);
      if (filters.minDuration !== "0") params.set("minDuration", filters.minDuration);
      if (filters.coldStart === "true") params.set("coldStart", "true");
      if (filters.query.trim()) params.set("q", filters.query.trim());
      if (before) params.set("before", before);
      return `/api/projects/${encodeURIComponent(name)}/logs?${params.toString()}`;
    },
    [name, filters],
  );

  const loadFirst = useCallback(async () => {
    setState("loading");
    try {
      const response = await fetch(historyUrl(), { credentials: "include" });
      if (!response.ok) {
        setState("error");
        return;
      }
      // SAFETY: a 2xx from the log-history endpoint is the LogPage contract.
      const page = (await response.json()) as LogPage;
      setRows(wrap(page.events));
      setNextBefore(page.nextBefore);
      setTruncated(page.windowTruncated);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [historyUrl, wrap]);

  const loadOlder = async () => {
    if (!nextBefore) return;
    try {
      const response = await fetch(historyUrl(nextBefore), { credentials: "include" });
      if (!response.ok) return;
      // SAFETY: a 2xx from the log-history endpoint is the LogPage contract.
      const page = (await response.json()) as LogPage;
      // wrap() bumps a ref for its keys, so it cannot run inside the updater:
      // React may call an updater more than once and it must stay pure.
      const older = wrap(page.events);
      setRows((current) => [...current, ...older]);
      setNextBefore(page.nextBefore);
    } catch {
      /* keep the button for a retry */
    }
  };

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  return (
    <div className="flex flex-col gap-4">
      <LiveTail name={name} active={Boolean(active)} />

      <Section
        id="request-logs"
        title="Request logs"
        description="Edge events for this project's route, newest first. Use the live tail above to watch new ones."
      >
        {!active && (
          <Banner tone="info">This project has no active route right now. Only past traffic is shown.</Banner>
        )}

        <search className="flex flex-wrap items-end gap-3">
          <FilterSelect
            label="Status"
            value={filters.statusClass}
            options={STATUS_OPTIONS}
            onValueChange={(value) => set("statusClass", value)}
          />
          <FilterSelect
            label="Method"
            value={filters.method}
            options={METHOD_OPTIONS}
            onValueChange={(value) => set("method", value)}
          />
          <FilterSelect
            label="Duration"
            value={filters.minDuration}
            options={DURATION_OPTIONS}
            onValueChange={(value) => set("minDuration", value)}
          />
          <FilterSelect
            label="Cold start"
            value={filters.coldStart}
            options={COLD_OPTIONS}
            onValueChange={(value) => set("coldStart", value)}
          />
          <Field label="Search" className="sm:max-w-md sm:flex-1">
            <Input
              type="search"
              placeholder="Match status, method, or failure text"
              value={filters.query}
              onChange={(event) => set("query", event.target.value)}
            />
          </Field>
          <Button disabled={!filtered} onClick={() => setFilters(EMPTY)}>
            Clear
          </Button>
        </search>

        {truncated && (
          <Banner tone="info">Showing the most recent window of activity; older history is not retained here.</Banner>
        )}

        {state === "loading" ? (
          <LoadingLine label="Loading events…" />
        ) : state === "error" ? (
          <Banner tone="danger">Could not load logs. Refresh and try again.</Banner>
        ) : rows.length === 0 ? (
          <EmptyState
            as="h3"
            title={filtered ? "No requests match" : "No requests yet"}
            description={filtered ? "No requests match these filters." : "No requests recorded for this route yet."}
          />
        ) : (
          <>
            <Table label="Request log, newest first" containerClassName="shadow-none ring-1 ring-hairline">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Time</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-end">Status</TableHead>
                  <TableHead className="text-end">Duration</TableHead>
                  <TableHead hideBelow="md">Start</TableHead>
                  <TableHead hideBelow="lg">Failure</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ key, record, title }) => (
                  <TableRow key={key}>
                    <TableCell className="whitespace-nowrap text-fg-muted tabular-nums" title={title}>
                      {relativeTime(record.at)}
                    </TableCell>
                    <TableCell className="font-mono text-sm">{record.method ?? "-"}</TableCell>
                    <TableCell
                      className={cn(
                        "text-end font-mono text-sm font-semibold tabular-nums",
                        STATUS_TEXT[statusTone(record.status)],
                      )}
                    >
                      {record.status}
                    </TableCell>
                    <TableCell className="text-end font-mono text-sm tabular-nums">{record.durationMs} ms</TableCell>
                    <TableCell hideBelow="md">
                      {record.coldStart ? (
                        <Badge tone="warning">Cold</Badge>
                      ) : (
                        <span className="text-fg-muted">Warm</span>
                      )}
                    </TableCell>
                    <TableCell hideBelow="lg" className="text-danger-fg">
                      {record.failure ?? <span className="text-fg-muted">-</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {nextBefore && (
              <div>
                <Button onClick={() => void loadOlder()}>Load older</Button>
              </div>
            )}
          </>
        )}
      </Section>

      <SproutOutput name={name} />
    </div>
  );
}

/**
 * #76 - stdout/stderr of the running sprout + its binding broker. This is where
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
      if (response.status === 404) {
        setState("missing");
        return;
      }
      if (!response.ok) {
        setState("error");
        return;
      }
      setText(await response.text());
      setState("ready");
    } catch {
      setState("error");
    }
  }, [name]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Section
      id="sprout-output"
      title="Sprout output"
      description="stdout and stderr from the active version's process and its binding broker."
      action={
        <Button loading={state === "loading"} onClick={() => void load()}>
          Refresh
        </Button>
      }
    >
      {state === "missing" ? (
        <EmptyState
          as="h3"
          title="Nothing running"
          description="No active deployment, so nothing is running to produce output."
        />
      ) : state === "error" ? (
        <Banner tone="danger">Could not read the sprout log. Refresh and try again.</Banner>
      ) : state === "idle" || (state === "loading" && text === "") ? (
        <LoadingLine label="Loading output…" />
      ) : (
        <CodeBlock
          label="Sprout process output"
          code={text === "" ? "(no output yet)" : text}
          wrap
          className="[&>pre]:max-h-[26rem]"
        />
      )}
    </Section>
  );
}
