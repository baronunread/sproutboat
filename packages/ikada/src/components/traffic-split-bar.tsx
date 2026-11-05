import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";

export interface TrafficVersion {
  id: string;
  /** "v47" */
  label: string;
  /** 0 to 100. */
  percent: number;
  /** Extra detail for the legend, e.g. "canary". */
  note?: ReactNode;
}

export interface TrafficSplitBarProps extends Omit<ComponentProps<"div">, "children"> {
  versions: readonly TrafficVersion[];
  /** Names the group for screen readers. */
  label?: string;
}

/** Segment fills in order. The lead version is ink, so a single version reads as "all of it". */
const fills = ["bg-fg", "bg-chart-requests", "bg-chart-series", "bg-chart-3xx", "bg-chart-other"] as const;
export const trafficFill = (index: number): string => fills[index % fills.length] ?? fills[0];

const pct = (n: number): string => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;

/**
 * How production traffic splits across versions. Each non-empty segment is a keyboard
 * stop with `role="meter"` ("v47, 90%"); the legend repeats the numbers as text. With no
 * traffic the bar is an empty track and says so.
 */
export function TrafficSplitBar({ versions, label = "Traffic split", className, ref, ...props }: TrafficSplitBarProps) {
  const total = versions.reduce((sum, v) => sum + Math.max(0, v.percent), 0);
  const visible = versions.flatMap((v, i) => (v.percent > 0 ? [{ v, i }] : []));

  return (
    <div ref={ref} role="group" aria-label={label} className={cn("flex flex-col gap-2.5", className)} {...props}>
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-hover">
        {visible.map(({ v, i }) => (
          <div key={v.id} style={{ flexBasis: `${v.percent}%` }} className="relative h-full min-w-1 shrink grow-0">
            {/* A real <meter> carries the semantics and the keyboard stop; the painted bar is its sibling. */}
            <meter
              tabIndex={0}
              aria-label={v.label}
              min={0}
              max={100}
              value={v.percent}
              aria-valuetext={`${v.label}, ${pct(v.percent)} of traffic`}
              className="peer sr-only"
            />
            <div
              aria-hidden="true"
              className={cn(
                "h-full rounded-xs peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-2 peer-focus-visible:outline-solid peer-focus-visible:outline-focus",
                trafficFill(i),
              )}
            />
          </div>
        ))}
      </div>
      <ul aria-hidden="true" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {total === 0 ? <li className="text-fg-muted">No traffic yet</li> : null}
        {versions.map((v, i) => (
          <li key={v.id} className="inline-flex items-center gap-1.5">
            <span className={cn("size-2.5 rounded-xs", trafficFill(i), v.percent <= 0 && "opacity-40")} />
            <span className="font-medium">{v.label}</span>
            <span className="tabular-nums text-fg-muted">{pct(v.percent)}</span>
            {v.note ? <span className="text-fg-muted">{v.note}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
