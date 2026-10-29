import { useEffect, useReducer, useRef, useState } from "react";
import {
  BADGE,
  Button,
  FILTER_BAR,
  FILTER_FIELD,
  FILTER_SEARCH,
  Panel,
  PanelHeading,
  SelectField,
  StatusMessage,
  TextField,
} from "./components";
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
import { cn } from "@/lib/utils";

const STATUS_OPTIONS = [
  ["all", "All statuses"],
  ["ok", "Succeeded"],
  ["error", "Errors"],
  ["2xx", "2xx"],
  ["3xx", "3xx"],
  ["4xx", "4xx"],
  ["5xx", "5xx"],
] as const;
const METHOD_OPTIONS = [
  ["all", "All methods"],
  ["GET", "GET"],
  ["POST", "POST"],
  ["PUT", "PUT"],
  ["PATCH", "PATCH"],
  ["DELETE", "DELETE"],
  ["HEAD", "HEAD"],
] as const;
const SAMPLING_OPTIONS = [
  ["1", "Every event"],
  ["0.5", "Half"],
  ["0.1", "One in ten"],
  ["0.01", "One in a hundred"],
] as const;

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const FULL_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

const STATUS_TONE = (status: number) =>
  status >= 500 ? "text-coral" : status >= 400 ? "text-coral" : status >= 300 ? "text-sky" : "text-success";

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

  return (
    <Panel variant="wide" aria-label="Live tail">
      <PanelHeading
        title="Live tail"
        description="Requests, console output and errors from this app as they happen."
        action={
          <div className="flex shrink-0 items-center gap-2.5">
            <span
              role="status"
              className={cn(
                "text-[0.75rem]",
                link === "live" && !state.paused
                  ? "text-brand before:mr-1.5 before:inline-block before:size-1.5 before:rounded-full before:bg-brand before:content-['']"
                  : "text-muted-foreground",
              )}
            >
              {label}
            </span>
            <Button variant={running ? "danger" : "quiet"} onClick={() => setRunning((on) => !on)}>
              {running ? "Stop live tail" : "Start live tail"}
            </Button>
          </div>
        }
      />

      {!active && (
        <StatusMessage>This project has no active route right now, so no new events will arrive.</StatusMessage>
      )}

      <search className={FILTER_BAR}>
        <SelectField
          label="Status"
          fieldClassName={FILTER_FIELD}
          value={filters.status}
          options={STATUS_OPTIONS}
          onValueChange={(value) => setFilter("status", value)}
        />
        <SelectField
          label="Method"
          fieldClassName={FILTER_FIELD}
          value={filters.method}
          options={METHOD_OPTIONS}
          onValueChange={(value) => setFilter("method", value)}
        />
        <SelectField
          label="Sampling"
          fieldClassName={FILTER_FIELD}
          value={filters.sampling}
          options={SAMPLING_OPTIONS}
          onValueChange={(value) => setFilter("sampling", value)}
        />
        <TextField
          label="Search"
          type="search"
          fieldClassName={FILTER_SEARCH}
          placeholder="URL, console text, or error text"
          value={searchText}
          onChange={(event) => onSearch(event.target.value)}
        />
        <Button variant="quiet" disabled={!filtered} onClick={resetFilters}>
          Reset
        </Button>
      </search>

      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <Button
          variant="quiet"
          disabled={!running}
          onClick={() => dispatch({ type: state.paused ? "resume" : "pause" })}
        >
          {state.paused ? "Resume" : "Pause"}
        </Button>
        <Button
          variant="quiet"
          disabled={state.rows.length === 0 && state.pending.length === 0}
          onClick={() => dispatch({ type: "clear" })}
        >
          Clear
        </Button>
        <span className="text-[0.75rem] text-muted-foreground tabular-nums" aria-live="polite">
          {state.paused && state.pending.length > 0
            ? `${state.pending.length} new while paused`
            : `${state.rows.length} ${state.rows.length === 1 ? "event" : "events"}`}
          {state.rows.length >= MAX_TAIL_ROWS ? `, showing the latest ${MAX_TAIL_ROWS}` : ""}
        </span>
      </div>

      {note && <StatusMessage>{note}</StatusMessage>}
      {state.dropped > 0 && (
        <StatusMessage tone="error">
          {state.dropped} {state.dropped === 1 ? "event was" : "events were"} skipped because the app is producing more
          than the tail's rate limit. Narrow the filters or lower the sampling rate to see everything that matters.
        </StatusMessage>
      )}

      <div className="relative">
        <div
          ref={scroller}
          onScroll={onScroll}
          role="log"
          aria-label="Live events"
          aria-live="off"
          tabIndex={0}
          className="h-[22rem] overflow-auto rounded-md border border-border bg-background focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {state.rows.length === 0 ? (
            <p className="m-0 px-4 py-5 text-[0.84rem] leading-relaxed text-muted-foreground">
              {running
                ? filtered
                  ? "Waiting for events that match these filters."
                  : "Waiting for traffic. Send a request to this app and it shows up here."
                : "Start the live tail to stream events. Console lines appear on their own: the runtime does not say which request printed them."}
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
          <Button variant="quiet" className="absolute end-3 bottom-3 bg-card" onClick={jumpToLatest}>
            Jump to latest
          </Button>
        )}
      </div>
    </Panel>
  );
}

const LINE =
  "flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t border-border px-3.5 py-2 first:border-t-0 hover:bg-accent";
const TIME = "shrink-0 font-mono text-[0.72rem] text-muted-foreground tabular-nums";

function TailLine({ row }: { row: TailRow }) {
  const { event } = row;
  const when = (
    <time
      className={TIME}
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
      <li className={cn(LINE, "bg-destructive/6")}>
        {when}
        <span className="w-9 shrink-0 font-mono text-[0.7rem] text-coral uppercase">error</span>
        <div className="min-w-0 flex-[1_1_14rem]">
          <p className="m-0 font-mono text-[0.78rem] leading-relaxed font-semibold break-words text-coral">
            {exception.name}: {exception.message}
          </p>
          {exception.stack && (
            <details className="mt-1">
              <summary className="cursor-pointer text-[0.72rem] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                Stack trace
              </summary>
              <pre className="mt-1.5 mb-0 overflow-x-auto font-mono text-[0.72rem] leading-relaxed text-muted-foreground">
                {exception.stack}
              </pre>
            </details>
          )}
        </div>
      </li>
    );
  if (!log) return null;
  return (
    <li className={LINE}>
      {when}
      <span
        className={cn(
          "w-9 shrink-0 font-mono text-[0.7rem] uppercase",
          log.level === "error" ? "text-coral" : "text-sky",
        )}
      >
        {log.level}
      </span>
      <span className="min-w-0 flex-[1_1_14rem] font-mono text-[0.78rem] leading-relaxed break-words whitespace-pre-wrap">
        {log.message.join(" ")}
      </span>
    </li>
  );
}

function RequestLine({ event, when }: { event: TailEvent; when: React.ReactNode }) {
  if (!event.event) return null;
  const { request, response } = event.event;
  const cpu = event.cpuTime === null ? null : `${Number(event.cpuTime.toFixed(1))} ms cpu`;
  return (
    <li className={LINE}>
      {when}
      <span className="w-12 shrink-0 font-mono text-[0.75rem] font-semibold">{request.method}</span>
      <span className="min-w-0 flex-[1_1_12rem] font-mono text-[0.78rem] break-all" title={request.url}>
        {eventPath(request.url)}
      </span>
      <span
        className={cn(
          "w-9 shrink-0 text-end font-mono text-[0.78rem] font-semibold tabular-nums",
          STATUS_TONE(response.status),
        )}
      >
        {response.status}
      </span>
      <span className={cn("shrink-0 sm:w-[7.5rem]", event.outcome === "ok" && "max-sm:hidden")}>
        {event.outcome !== "ok" && <span className={cn(BADGE, "text-coral")}>{event.outcome}</span>}
      </span>
      <span className="shrink-0 text-[0.72rem] max-sm:basis-full sm:w-[8.5rem] sm:text-end text-muted-foreground tabular-nums">
        {cpu ? `${cpu}, ` : ""}
        {event.wallTime} ms
      </span>
    </li>
  );
}

const reduceTail = (state: TailState, action: TailAction): TailState => tailReducer(state, action);
