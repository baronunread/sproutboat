import { Banner, Button, Field, Input, StatusDot, Switch, cn } from "@sproutboat/ikada";
import { useEffect, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import { LogCell, LogRow, statusTone } from "./log-row";
import { FilterSelect, Section } from "./project-ui";
import {
  EMPTY_TAIL,
  eventPath,
  MAX_TAIL_ROWS,
  NO_TAIL_FILTERS,
  tailFiltered,
  tailQuery,
  tailReducer,
  type TailEvent,
  type TailFilters,
  type TailAction,
  type TailFrame,
  type TailState,
  type TailRow,
} from "./tail-state";

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "ok", label: "Succeeded" },
  { value: "error", label: "Errors" },
  { value: "2xx", label: "2xx" },
  { value: "3xx", label: "3xx" },
  { value: "4xx", label: "4xx" },
  { value: "5xx", label: "5xx" },
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
const SAMPLING_OPTIONS = [
  { value: "1", label: "Every event" },
  { value: "0.5", label: "Half" },
  { value: "0.1", label: "One in ten" },
  { value: "0.01", label: "One in a hundred" },
];

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const FULL_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

type Link = "off" | "connecting" | "live" | "reconnecting";

/** The page's live tail: one SSE connection to the tail endpoint, filtered on the server. */
export function LiveTail({ name, active }: { name: string; active: boolean }) {
  const [running, setRunning] = useState(false);
  const [link, setLink] = useState<Link>("off");
  const [note, setNote] = useState("");
  const [filters, setFilters] = useState<TailFilters>(NO_TAIL_FILTERS);
  const [searchText, setSearchText] = useState("");
  const [state, dispatch] = useReducer(reduceTail, EMPTY_TAIL);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [behind, setBehind] = useState(false);

  // Committing the search a beat after typing stops keeps one request per word, not per key.
  useEffect(() => {
    const timer = setTimeout(() => setFilters((current) => ({ ...current, search: searchText })), 400);
    return () => clearTimeout(timer);
  }, [searchText]);

  const query = tailQuery(filters);
  const filtered = tailFiltered(filters) || searchText !== "";

  // The stream's whole lifecycle is this effect, so a filter change reconnects
  // with the new server-side filters and stopping or leaving the page closes it.
  useEffect(() => {
    if (!running) return;
    setLink("connecting");
    const stream = new EventSource(`/api/projects/${encodeURIComponent(name)}/tail${query ? `?${query}` : ""}`);
    stream.onmessage = (message) => {
      // SAFETY: the tail endpoint sends one TailFrame JSON object per message.
      const frame = JSON.parse(message.data) as TailFrame;
      if (frame.type === "ready") {
        setLink("live");
        setNote("");
      } else if (frame.type === "event") dispatch({ type: "events", events: [frame.event] });
      else if (frame.type === "dropped") dispatch({ type: "dropped", count: frame.count });
      else {
        // The server caps one connection at ten minutes; EventSource reconnects on its own.
        setLink("reconnecting");
        setNote("Reached the server's connection limit, reconnecting.");
      }
    };
    stream.onerror = () => {
      if (stream.readyState === EventSource.CLOSED) {
        setNote("Could not start the live tail. Check that you are signed in, then try again.");
        setLink("off");
        setRunning(false);
      } else {
        setLink("reconnecting");
        setNote("Connection lost, reconnecting.");
      }
    };
    return () => {
      stream.close();
      setLink("off");
    };
  }, [running, name, query]);

  // Follow the newest row, unless the reader has scrolled up to look at something.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    // An emptied list has nothing to be behind on: follow again and drop the jump button.
    if (state.rows.length === 0) {
      following.current = true;
      setBehind(false);
    } else if (following.current) element.scrollTop = element.scrollHeight;
  }, [state.rows]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    following.current = atEnd;
    setBehind(!atEnd);
  };
  const jumpToLatest = () => {
    const element = scroller.current;
    if (!element) return;
    following.current = true;
    element.scrollTop = element.scrollHeight;
    setBehind(false);
  };

  const setFilter = <K extends keyof TailFilters>(key: K, value: TailFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
    dispatch({ type: "clear" });
  };
  const onSearch = (value: string) => {
    setSearchText(value);
    dispatch({ type: "clear" });
  };
  const resetFilters = () => {
    setFilters(NO_TAIL_FILTERS);
    setSearchText("");
    dispatch({ type: "clear" });
  };

  const label = link === "live" ? (state.paused ? "Paused" : "Live") : link === "off" ? "Off" : "Connecting";
  const dot =
    link === "live" && !state.paused ? (
      <StatusDot status="success" live label={label} />
    ) : link === "off" ? (
      <StatusDot status="neutral" label={label} />
    ) : (
      <StatusDot status="warning" pulse={link !== "live"} label={label} />
    );

  return (
    <Section
      id="live-tail"
      title="Live tail"
      description="Requests, console output and errors from this app as they happen."
      action={
        <>
          <span role="status" className="text-base">
            {dot}
          </span>
          <Switch label="Stream events" checked={running} onCheckedChange={setRunning} />
        </>
      }
    >
      {!active && (
        <Banner tone="info">This project has no active route right now, so no new events will arrive.</Banner>
      )}

      <search className="flex flex-wrap items-end gap-3">
        <FilterSelect
          label="Status"
          value={filters.status}
          options={STATUS_OPTIONS}
          onValueChange={(value) => setFilter("status", value)}
        />
        <FilterSelect
          label="Method"
          value={filters.method}
          options={METHOD_OPTIONS}
          onValueChange={(value) => setFilter("method", value)}
        />
        <FilterSelect
          label="Sampling"
          value={filters.sampling}
          options={SAMPLING_OPTIONS}
          onValueChange={(value) => setFilter("sampling", value)}
        />
        <Field label="Search" className="sm:max-w-md sm:flex-1">
          <Input
            type="search"
            placeholder="URL, console text, or error text"
            value={searchText}
            onChange={(event) => onSearch(event.target.value)}
          />
        </Field>
        <Button disabled={!filtered} onClick={resetFilters}>
          Reset
        </Button>
      </search>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!running} onClick={() => dispatch({ type: state.paused ? "resume" : "pause" })}>
          {state.paused ? "Resume" : "Pause"}
        </Button>
        <Button
          size="sm"
          disabled={state.rows.length === 0 && state.pending.length === 0}
          onClick={() => dispatch({ type: "clear" })}
        >
          Clear
        </Button>
        <span className="text-sm text-fg-muted tabular-nums" aria-live="polite">
          {state.paused && state.pending.length > 0
            ? `${state.pending.length} new while paused`
            : `${state.rows.length} ${state.rows.length === 1 ? "event" : "events"}`}
          {state.rows.length >= MAX_TAIL_ROWS ? `, showing the latest ${MAX_TAIL_ROWS}` : ""}
        </span>
      </div>

      {note && <Banner tone="warning">{note}</Banner>}
      {state.dropped > 0 && (
        <Banner tone="danger">
          {state.dropped} {state.dropped === 1 ? "event was" : "events were"} skipped because the app is producing more
          than the tail&apos;s rate limit. Narrow the filters or lower the sampling rate to see everything that matters.
        </Banner>
      )}

      <div className="relative">
        <div
          ref={scroller}
          onScroll={onScroll}
          role="log"
          aria-label="Live events"
          aria-live="off"
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scroll region must be keyboard-focusable
          tabIndex={0}
          className="h-[22rem] overflow-auto rounded-lg bg-code-bg shadow-card outline-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
        >
          {state.rows.length === 0 ? (
            <p className="m-0 px-4 py-5 text-base text-fg-muted">
              {running
                ? filtered
                  ? "Waiting for events that match these filters."
                  : "Waiting for traffic. Send a request to this app and it shows up here."
                : "Turn on the live tail to stream events. Console lines appear on their own: the runtime does not say which request printed them."}
            </p>
          ) : (
            <ol className="m-0 list-none p-0">
              {state.rows.map((row) => (
                <TailLine key={row.key} row={row} />
              ))}
            </ol>
          )}
        </div>
        {behind && (
          <Button size="sm" variant="primary" className="absolute end-3 bottom-3" onClick={jumpToLatest}>
            Jump to latest
          </Button>
        )}
      </div>
    </Section>
  );
}

function TailLine({ row }: { row: TailRow }) {
  const { event } = row;
  const when = (
    <time
      className="shrink-0 text-xs text-fg-muted tabular-nums"
      dateTime={new Date(event.eventTimestamp).toISOString()}
      title={FULL_TIME.format(event.eventTimestamp)}
    >
      {CLOCK.format(event.eventTimestamp)}
    </time>
  );
  if (event.event) return <RequestLine event={event} when={when} />;
  const [log] = event.logs;
  const [exception] = event.exceptions;
  if (exception)
    return (
      <LogRow time={when} failed>
        <LogCell tone="danger" className="w-10 shrink-0 text-xs uppercase">
          error
        </LogCell>
        <div className="min-w-0 flex-[1_1_14rem]">
          <p className="m-0 font-semibold break-words text-danger-fg">
            {exception.name}: {exception.message}
          </p>
          {exception.stack && (
            <details className="mt-1">
              <summary className="cursor-pointer rounded-xs text-xs text-fg-muted outline-hidden hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
                Stack trace
              </summary>
              <pre className="mt-1.5 mb-0 overflow-x-auto text-xs text-fg-muted">{exception.stack}</pre>
            </details>
          )}
        </div>
      </LogRow>
    );
  if (!log) return null;
  return (
    <LogRow time={when}>
      <LogCell tone={log.level === "error" ? "danger" : "info"} className="w-10 shrink-0 text-xs uppercase">
        {log.level}
      </LogCell>
      <LogCell className="min-w-0 flex-[1_1_14rem] break-words whitespace-pre-wrap">{log.message.join(" ")}</LogCell>
    </LogRow>
  );
}

function RequestLine({ event, when }: { event: TailEvent; when: ReactNode }) {
  if (!event.event) return null;
  const { request, response } = event.event;
  const cpu = event.cpuTime === null ? null : `${Number(event.cpuTime.toFixed(1))} ms cpu`;
  return (
    <LogRow time={when}>
      <LogCell className="w-12 shrink-0 font-semibold">{request.method}</LogCell>
      <LogCell className="min-w-0 flex-[1_1_12rem] break-all" title={request.url}>
        {eventPath(request.url)}
      </LogCell>
      <LogCell tone={statusTone(response.status)} className="w-9 shrink-0 text-end font-semibold tabular-nums">
        {response.status}
      </LogCell>
      <LogCell
        tone="danger"
        className={cn("shrink-0 text-xs sm:w-[7.5rem]", event.outcome === "ok" && "max-sm:hidden")}
      >
        {event.outcome === "ok" ? null : event.outcome}
      </LogCell>
      <LogCell
        tone="default"
        className="shrink-0 text-xs text-fg-muted tabular-nums max-sm:basis-full sm:w-[8.5rem] sm:text-end"
      >
        {cpu ? `${cpu}, ` : ""}
        {event.wallTime} ms
      </LogCell>
    </LogRow>
  );
}

const reduceTail = (state: TailState, action: TailAction): TailState => tailReducer(state, action);
