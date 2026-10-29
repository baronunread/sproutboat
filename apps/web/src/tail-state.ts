/**
 * Live tail state for the logs page: the wire types of
 * `GET /api/projects/:name/tail`, a bounded row buffer with pause/resume, and
 * the query string the filters turn into. Kept free of React so it can be
 * tested directly.
 */

export type TailLog = { level: string; message: string[]; timestamp: number };
export type TailException = { name: string; message: string; timestamp: number; stack?: string };
export type TailEvent = {
  scriptName: string;
  outcome: string;
  eventTimestamp: number;
  event: { request: { url: string; method: string }; response: { status: number } } | null;
  cpuTime: number | null;
  wallTime: number;
  logs: TailLog[];
  exceptions: TailException[];
};
export type TailFrame =
  | { type: "ready" }
  | { type: "event"; event: TailEvent }
  | { type: "dropped"; count: number; bytes?: number; reason: string }
  | { type: "closed"; reason: string };

export type TailRow = { key: number; event: TailEvent };

/** The most rows the page keeps; older ones fall off the top. */
export const MAX_TAIL_ROWS = 500;

export type TailState = {
  rows: TailRow[];
  /** Events that arrived while paused, applied on resume. Bounded like `rows`. */
  pending: TailRow[];
  paused: boolean;
  dropped: number;
  nextKey: number;
};

export type TailAction =
  | { type: "events"; events: TailEvent[] }
  | { type: "dropped"; count: number }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "clear" };

export const EMPTY_TAIL: TailState = { rows: [], pending: [], paused: false, dropped: 0, nextKey: 0 };

/**
 * One row per request, per console line and per exception: a grouped console
 * event is split here, so the bound counts lines and each row renders alone.
 */
export function rowsOf(event: TailEvent): TailEvent[] {
  if (event.event) return [event];
  return [
    ...event.logs.map((log) => ({ ...event, logs: [log], exceptions: [] })),
    ...event.exceptions.map((exception) => ({ ...event, logs: [], exceptions: [exception] })),
  ];
}

const bound = (rows: TailRow[], max: number): TailRow[] => (rows.length > max ? rows.slice(rows.length - max) : rows);

export function tailReducer(state: TailState, action: TailAction, max = MAX_TAIL_ROWS): TailState {
  switch (action.type) {
    case "events": {
      const added: TailRow[] = [];
      for (const incoming of action.events)
        for (const event of rowsOf(incoming)) added.push({ key: state.nextKey + added.length, event });
      const nextKey = state.nextKey + added.length;
      return state.paused
        ? { ...state, pending: bound([...state.pending, ...added], max), nextKey }
        : { ...state, rows: bound([...state.rows, ...added], max), nextKey };
    }
    case "dropped":
      return { ...state, dropped: state.dropped + action.count };
    case "pause":
      return { ...state, paused: true };
    case "resume":
      return { ...state, paused: false, rows: bound([...state.rows, ...state.pending], max), pending: [] };
    case "clear":
      return { ...EMPTY_TAIL, paused: state.paused, nextKey: state.nextKey };
  }
}

export type TailFilters = { status: string; method: string; search: string; sampling: string };
export const NO_TAIL_FILTERS: TailFilters = { status: "all", method: "all", search: "", sampling: "1" };

export function tailQuery(filters: TailFilters): string {
  const params = new URLSearchParams();
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.method !== "all") params.set("method", filters.method);
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.sampling !== "1") params.set("sampling-rate", filters.sampling);
  return params.toString();
}

export function tailFiltered(filters: TailFilters): boolean {
  return tailQuery(filters) !== "";
}

/** The path of an event's URL, which is all the page needs: every row is the same host. */
export function eventPath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname || "/";
  } catch {
    return url;
  }
}
