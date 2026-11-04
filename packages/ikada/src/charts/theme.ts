import type { ColorToken } from "../tokens.generated";
import { colorVar } from "../tokens.generated";

/** The chart color tokens, by the name a chart uses for them. */
export const chartTokens = {
  requests: "chart-requests",
  errors: "chart-errors",
  deploy: "chart-deploy",
  grid: "chart-grid",
  "2xx": "chart-2xx",
  "3xx": "chart-3xx",
  "4xx": "chart-4xx",
  "5xx": "chart-5xx",
  other: "chart-other",
  series: "chart-series",
} as const satisfies Record<string, ColorToken>;

export type ChartColorName = keyof typeof chartTokens;

/**
 * `var(--sb-chart-*)` references. Marks take these strings, so a chart follows the
 * theme (light, dark) with no rebuild of its definition.
 */
export const chartColors = {
  requests: colorVar(chartTokens.requests),
  errors: colorVar(chartTokens.errors),
  deploy: colorVar(chartTokens.deploy),
  grid: colorVar(chartTokens.grid),
  "2xx": colorVar(chartTokens["2xx"]),
  "3xx": colorVar(chartTokens["3xx"]),
  "4xx": colorVar(chartTokens["4xx"]),
  "5xx": colorVar(chartTokens["5xx"]),
  other: colorVar(chartTokens.other),
  series: colorVar(chartTokens.series),
} satisfies Record<ChartColorName, string>;

/** HTTP status class to its chart color; unknown classes fall back to `other`. */
export const statusClassColor = (cls: string): string =>
  chartColors[cls === "2xx" || cls === "3xx" || cls === "4xx" || cls === "5xx" ? cls : "other"];

/** Class that scopes the tooltip surface and palette variables defined in theme.css. */
export const chartClassName = "sb-chart";
