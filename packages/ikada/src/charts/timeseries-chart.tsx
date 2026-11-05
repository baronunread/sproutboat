import { areaY, defineChart, lineY, ruleX, text } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { decorative } from "@tanstack/charts/mark/decorative";
import { tooltip } from "@tanstack/charts/tooltip";
import { useMemo } from "react";
import { cn } from "../lib/cn";
import { formatCompact, formatNumber } from "../lib/format";
import { chartClassName, chartColors } from "./theme";
import type { ChartColorName } from "./theme";

export interface TimeseriesPoint {
  /** Any number on one shared axis: epoch milliseconds, or hours since midnight. */
  time: number;
  value: number;
}

export interface TimeseriesSeries {
  id: string;
  /** Shown in the tooltip and read by screen readers. */
  label: string;
  data: readonly TimeseriesPoint[];
  /** A chart color token name. Defaults to `requests`. */
  color?: ChartColorName;
  /** Fills under the line with the same color at 14% opacity. */
  area?: boolean;
  dashed?: boolean;
}

export interface DeployMarker {
  time: number;
  /** Short label printed beside the rule, e.g. "v48". */
  label: string;
}

export interface TimeseriesChartProps {
  series: readonly TimeseriesSeries[];
  /** A dashed vertical rule with a label, in the `chart-deploy` color. */
  deploy?: DeployMarker | readonly DeployMarker[];
  /** Accessible name of the chart. Required. */
  ariaLabel: string;
  height?: number;
  /** [min, max] of the value axis. Defaults to 0 up to the largest value, rounded up. */
  yDomain?: readonly [number, number];
  xDomain?: readonly [number, number];
  /** Formats x ticks and the tooltip heading. */
  formatTime?: (time: number) => string;
  /** Formats y ticks and tooltip values. */
  formatValue?: (value: number) => string;
  /** Formats y axis ticks. Defaults to compact numbers (1.5K) with no unit, so labels stay narrow. */
  formatTick?: (value: number) => string;
  /** Approximate number of x ticks. Defaults to 5. */
  xTicks?: number;
  yTicks?: number;
  className?: string;
}

interface Row {
  time: number;
  value: number;
  label: string;
}

const compact = (value: number): string => formatCompact(value, { maximumFractionDigits: 1 });

const defaultValue = (value: number): string => formatNumber(value);

const markers = (deploy: TimeseriesChartProps["deploy"]): readonly DeployMarker[] =>
  deploy === undefined ? [] : "time" in deploy ? [deploy] : deploy;

/**
 * A line (and optional area) chart on TanStack Charts, themed by the chart tokens:
 * grid and tooltip follow light and dark, and the deploy marker is a dashed rule
 * so a before and after read at a glance.
 */
export function TimeseriesChart({
  series,
  deploy,
  ariaLabel,
  height = 210,
  yDomain,
  xDomain,
  formatTime = String,
  formatValue = defaultValue,
  formatTick = compact,
  xTicks = 5,
  yTicks = 4,
  className,
}: TimeseriesChartProps) {
  const definition = useMemo(() => {
    const all = series.flatMap((s) => s.data);
    const xs = all.map((p) => p.time);
    const x0 = xDomain?.[0] ?? Math.min(...xs);
    const x1 = xDomain?.[1] ?? Math.max(...xs);
    const yMax = yDomain?.[1] ?? Math.max(1, ...all.map((p) => p.value)) * 1.08;
    const yMin = yDomain?.[0] ?? 0;
    const marks = [
      ...series.flatMap((s) => {
        const color = chartColors[s.color ?? "requests"];
        const rows: Row[] = s.data.map((p) => ({ ...p, label: s.label }));
        return [
          ...(s.area
            ? [areaY(rows, { x: "time", y: "value", fill: color, fillOpacity: 0.14, id: `${s.id}-area` })]
            : []),
          lineY(rows, {
            x: "time",
            y: "value",
            stroke: color,
            strokeWidth: 2,
            strokeDasharray: s.dashed ? "6 4" : undefined,
            id: s.id,
          }),
        ];
      }),
      ...markers(deploy).flatMap((m, i) => [
        decorative(
          ruleX([{ time: m.time }], {
            x: "time",
            stroke: chartColors.deploy,
            strokeOpacity: 0.8,
            strokeDasharray: "2 4",
            strokeWidth: 1.5,
            id: `deploy-${i}`,
          }),
        ),
        decorative(
          text([{ time: m.time, y: yMax * 0.96, t: m.label }], {
            x: "time",
            y: "y",
            text: "t",
            anchor: "start",
            dx: 8,
            fill: chartColors.deploy,
            fontSize: 11,
            fontWeight: 600,
            id: `deploy-label-${i}`,
          }),
        ),
      ]),
    ];
    return defineChart({
      marks,
      scales: {
        x: {
          scale: scaleLinear().domain([x0, x1]),
          axis: { line: false, ticks: { count: xTicks, size: 0, format: formatTime } },
        },
        y: {
          scale: scaleLinear().domain([yMin, yMax]),
          axis: { line: false, ticks: { count: yTicks, size: 0, format: formatTick } },
          grid: { stroke: chartColors.grid, strokeOpacity: 1 },
        },
      },
      focus: "nearest-x",
      maxFocusDistance: Number.POSITIVE_INFINITY,
      tooltip: {
        use: tooltip,
        format: (p: { datum: Row }) => `${formatTime(p.datum.time)}\n${p.datum.label}: ${formatValue(p.datum.value)}`,
      },
    });
  }, [series, deploy, yDomain, xDomain, formatTime, formatValue, formatTick, xTicks, yTicks]);

  return (
    <Chart
      definition={definition}
      height={height}
      ariaLabel={ariaLabel}
      className={cn(chartClassName, "w-full text-fg-muted", className)}
    />
  );
}
