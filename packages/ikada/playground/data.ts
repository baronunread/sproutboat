import type { TimeseriesPoint } from "../src/charts";

/** Deterministic pseudo-random numbers, so screenshots do not change between runs. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

const rand = rng(7);
const hours = Array.from({ length: 49 }, (_, i) => i / 2);
const diurnal = (h: number): number => 0.55 + 0.45 * Math.sin(((h - 6) / 24) * 2 * Math.PI);

export const DEPLOY_HOUR = 15.5;

const rows = hours.map((h) => {
  const base = diurnal(h);
  const requests = Math.round(900 + 1400 * base * (0.94 + 0.12 * rand()));
  const after = h >= DEPLOY_HOUR && h < 18 ? 1 : 0;
  const errors = Math.round(
    requests * (0.0032 + 0.002 * rand()) + (after ? 12 + 10 * Math.sin((h - DEPLOY_HOUR) * 2.2) : 0),
  );
  const p50 = Math.round(36 + 12 * base + 3 * rand() + (after ? 3 : 0));
  const p99 = Math.round(150 + 70 * base + 25 * rand() - (h > 18 ? 10 : 0) + (after ? 22 : 0));
  return { h, requests, errors, p50, p99 };
});

const pick = (key: "requests" | "errors" | "p50" | "p99"): TimeseriesPoint[] =>
  rows.map((r) => ({ time: r.h, value: r[key] }));

export const requests = pick("requests");
export const errors = pick("errors");
export const p50 = pick("p50");
export const p99 = pick("p99");

export const clock = (h: number): string => `${String(Math.floor(h) % 24).padStart(2, "0")}:${h % 1 ? "30" : "00"}`;
