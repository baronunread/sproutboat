import { expect, test } from "bun:test";
import { EMPTY_TAIL, eventPath, tailQuery, tailReducer, type TailEvent, type TailState } from "./tail-state";

const event = (n: number): TailEvent => ({
  scriptName: "app",
  outcome: "ok",
  eventTimestamp: n,
  event: { request: { url: `https://app.a.test/${n}`, method: "GET" }, response: { status: 200 } },
  cpuTime: 1,
  wallTime: 2,
  logs: [],
  exceptions: [],
});
const apply = (state: TailState, ...events: number[]) =>
  tailReducer(state, { type: "events", events: events.map(event) }, 3);

test("rows are bounded and keep the newest, keys keep counting", () => {
  let state = apply(EMPTY_TAIL, 1, 2);
  state = apply(state, 3, 4, 5);
  expect(state.rows.map((row) => row.event.eventTimestamp)).toEqual([3, 4, 5]);
  expect(state.rows.map((row) => row.key)).toEqual([2, 3, 4]);
});

test("pause holds events back, resume applies them in order, both bounded", () => {
  let state = tailReducer(apply(EMPTY_TAIL, 1), { type: "pause" });
  state = apply(state, 2, 3, 4, 5);
  expect(state.rows.map((row) => row.event.eventTimestamp)).toEqual([1]);
  expect(state.pending.map((row) => row.event.eventTimestamp)).toEqual([3, 4, 5]);
  state = tailReducer(state, { type: "resume" }, 3);
  expect(state.paused).toBe(false);
  expect(state.pending).toEqual([]);
  expect(state.rows.map((row) => row.event.eventTimestamp)).toEqual([3, 4, 5]);
});

test("clear empties rows and pending but keeps the pause state and key counter", () => {
  let state = tailReducer(apply(EMPTY_TAIL, 1, 2), { type: "pause" });
  state = apply(state, 3);
  state = tailReducer(state, { type: "dropped", count: 4 });
  state = tailReducer(state, { type: "clear" });
  expect(state).toMatchObject({ rows: [], pending: [], dropped: 0, paused: true, nextKey: 3 });
});

test("filters become the endpoint's query", () => {
  expect(tailQuery({ status: "all", method: "all", search: "", sampling: "1" })).toBe("");
  const query = new URLSearchParams(tailQuery({ status: "5xx", method: "POST", search: " boom ", sampling: "0.1" }));
  expect(Object.fromEntries(query)).toEqual({ status: "5xx", method: "POST", search: "boom", "sampling-rate": "0.1" });
});

test("eventPath drops the host and tolerates junk", () => {
  expect(eventPath("https://app.a.test/api/x")).toBe("/api/x");
  expect(eventPath("https://app.a.test")).toBe("/");
  expect(eventPath("not a url")).toBe("not a url");
});

test("a grouped console event becomes one row per line and per exception", () => {
  const grouped: TailEvent = {
    ...event(1),
    event: null,
    logs: [
      { level: "log", message: ["a"], timestamp: 1 },
      { level: "log", message: ["b"], timestamp: 1 },
    ],
    exceptions: [{ name: "Error", message: "x", timestamp: 1 }],
  };
  const state = tailReducer(EMPTY_TAIL, { type: "events", events: [grouped, event(2)] });
  expect(
    state.rows.map((row) => row.event.logs[0]?.message[0] ?? row.event.exceptions[0]?.message ?? "request"),
  ).toEqual(["a", "b", "x", "request"]);
  expect(state.rows.map((row) => row.key)).toEqual([0, 1, 2, 3]);
});
