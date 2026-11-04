import type { ColorName } from "./tokens";

/** text: 4.5:1. large: 3:1 (18px+ or 14px+ bold). ui: 3:1 (borders, dots, fills, rings). */
export type PairKind = "text" | "large" | "ui";

export const minRatio = { text: 4.5, large: 3, ui: 3 } satisfies Record<PairKind, number>;

export interface Pair {
  fg: ColorName;
  bg: ColorName;
  kind: PairKind;
  note: string;
}

const pair = (fg: ColorName, bg: ColorName, kind: PairKind, note: string): Pair => ({
  fg,
  bg,
  kind,
  note,
});

const pageSurfaces = ["canvas", "surface", "well", "hover", "raised"] as const;
const statusFamilies = [
  { name: "brand", fg: "brand-fg", soft: "brand-soft" },
  { name: "warn", fg: "warn-fg", soft: "warn-soft" },
  { name: "danger", fg: "danger-fg", soft: "danger-soft" },
  { name: "info", fg: "info-fg", soft: "info-soft" },
  { name: "neutral", fg: "neutral-fg", soft: "neutral-soft" },
] as const;
/** Where a control edge, a dot or a chart mark can sit. */
const markBackdrops = ["surface", "canvas", "well"] as const;
const chartMarks = [
  "chart-requests",
  "chart-errors",
  "chart-deploy",
  "chart-2xx",
  "chart-3xx",
  "chart-4xx",
  "chart-5xx",
  "chart-other",
  "chart-series",
] as const;

export const pairs: Pair[] = [
  ...pageSurfaces.map((bg) => pair("fg", bg, "text", "Body text")),
  ...pageSurfaces.map((bg) => pair("fg-muted", bg, "text", "Secondary text, placeholders")),
  pair("fg", "code-bg", "text", "Code and log text"),
  pair("fg-muted", "code-bg", "text", "Log timestamps"),
  pair("fg", "diff-add", "text", "Added line"),
  pair("fg", "diff-del", "text", "Removed line"),
  pair("on-brand", "brand", "text", "Primary button label"),
  pair("on-brand", "brand-hover", "text", "Primary button label, hover"),
  pair("on-danger", "danger", "text", "Destructive button label"),
  pair("on-danger", "danger-hover", "text", "Destructive button label, hover"),
  ...statusFamilies.flatMap((f) => [
    pair(f.fg, "surface", "text", `${f.name} text on surface`),
    pair(f.fg, "canvas", "text", `${f.name} text on canvas`),
    pair(f.fg, "raised", "text", `${f.name} text on a floating layer`),
    pair(f.fg, f.soft, "text", `${f.name} badge`),
  ]),
  pair("danger-fg", "surface", "large", "Danger zone heading"),
  ...markBackdrops.flatMap((bg) => [
    pair("control-edge", bg, "ui", "Input, select, checkbox edge"),
    pair("brand", bg, "ui", "Switch on, checkbox checked, primary fill"),
    pair("brand-dot", bg, "ui", "Success dot"),
    pair("warn-dot", bg, "ui", "Fallback and warning dot"),
    pair("danger-dot", bg, "ui", "Error dot"),
    pair("info-dot", bg, "ui", "Info dot"),
    pair("neutral-dot", bg, "ui", "Idle and unknown dot"),
  ]),
  ...pageSurfaces.map((bg) => pair("focus", bg, "ui", "Focus ring")),
  pair("danger", "surface", "ui", "Destructive button fill"),
  ...markBackdrops.flatMap((bg) => chartMarks.map((name) => pair(name, bg, "ui", "Chart mark"))),
];
