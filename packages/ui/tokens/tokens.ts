/**
 * Sproutboat design tokens: the single source of truth.
 *
 * `bun run tokens` reads this file and writes
 *   - src/theme.css            (Tailwind v4 @theme plus light and dark variables)
 *   - src/tokens.generated.ts  (the same values as typed TS exports)
 *   - the generated tables inside DESIGN.md
 * Never edit those outputs by hand. `test/tokens.test.ts` fails when they drift
 * from this file, and when a text or UI pair drops below its WCAG ratio.
 *
 * Colors are OKLCH strings, always opaque (the contrast math needs a known
 * backdrop), except `scrim`, which is a translucent overlay and is not paired.
 */

export const colorNames = [
  "canvas",
  "surface",
  "raised",
  "hairline",
  "hairline-strong",
  "control-edge",
  "focus",
  "fg",
  "fg-muted",
  "brand",
  "brand-hover",
  "on-brand",
  "brand-fg",
  "brand-soft",
  "brand-edge",
  "brand-dot",
  "warn-fg",
  "warn-soft",
  "warn-edge",
  "warn-dot",
  "danger",
  "danger-hover",
  "on-danger",
  "danger-fg",
  "danger-soft",
  "danger-edge",
  "danger-dot",
  "info-fg",
  "info-soft",
  "info-edge",
  "info-dot",
  "neutral-dot",
  "code-bg",
  "diff-add",
  "diff-del",
  "chart-2xx",
  "chart-3xx",
  "chart-4xx",
  "chart-5xx",
  "chart-other",
  "chart-series",
  "scrim",
] as const;

export type ColorName = (typeof colorNames)[number];
export type ColorTheme = Record<ColorName, string>;

/** Dark is the default theme: it applies with no `data-theme` attribute. */
export const dark = {
  canvas: "oklch(0.155 0.006 255)",
  surface: "oklch(0.195 0.008 255)",
  raised: "oklch(0.235 0.01 255)",
  hairline: "oklch(0.29 0.011 255)",
  "hairline-strong": "oklch(0.39 0.012 255)",
  "control-edge": "oklch(0.58 0.014 255)",
  focus: "oklch(0.965 0.004 255)",
  fg: "oklch(0.965 0.004 255)",
  "fg-muted": "oklch(0.76 0.012 255)",
  brand: "oklch(0.8 0.17 150)",
  "brand-hover": "oklch(0.85 0.17 150)",
  "on-brand": "oklch(0.19 0.04 150)",
  "brand-fg": "oklch(0.82 0.16 150)",
  "brand-soft": "oklch(0.27 0.05 150)",
  "brand-edge": "oklch(0.38 0.08 150)",
  "brand-dot": "oklch(0.8 0.17 150)",
  "warn-fg": "oklch(0.85 0.14 82)",
  "warn-soft": "oklch(0.27 0.05 80)",
  "warn-edge": "oklch(0.42 0.08 80)",
  "warn-dot": "oklch(0.82 0.16 80)",
  danger: "oklch(0.72 0.17 25)",
  "danger-hover": "oklch(0.77 0.16 25)",
  "on-danger": "oklch(0.18 0.04 25)",
  "danger-fg": "oklch(0.78 0.15 25)",
  "danger-soft": "oklch(0.26 0.06 25)",
  "danger-edge": "oklch(0.42 0.1 25)",
  "danger-dot": "oklch(0.72 0.17 25)",
  "info-fg": "oklch(0.8 0.1 245)",
  "info-soft": "oklch(0.26 0.04 250)",
  "info-edge": "oklch(0.4 0.07 250)",
  "info-dot": "oklch(0.75 0.13 245)",
  "neutral-dot": "oklch(0.62 0.012 255)",
  "code-bg": "oklch(0.17 0.007 255)",
  "diff-add": "oklch(0.25 0.05 150)",
  "diff-del": "oklch(0.25 0.05 22)",
  "chart-2xx": "oklch(0.78 0.16 150)",
  "chart-3xx": "oklch(0.76 0.1 240)",
  "chart-4xx": "oklch(0.82 0.15 75)",
  "chart-5xx": "oklch(0.7 0.18 25)",
  "chart-other": "oklch(0.62 0.012 255)",
  "chart-series": "oklch(0.76 0.1 285)",
  scrim: "oklch(0 0 0 / 0.6)",
} satisfies ColorTheme;

export const light = {
  canvas: "oklch(0.982 0.002 250)",
  surface: "oklch(1 0 0)",
  raised: "oklch(0.963 0.003 250)",
  hairline: "oklch(0.915 0.004 250)",
  "hairline-strong": "oklch(0.83 0.005 250)",
  "control-edge": "oklch(0.6 0.008 250)",
  focus: "oklch(0.2 0.005 250)",
  fg: "oklch(0.2 0.005 250)",
  "fg-muted": "oklch(0.47 0.008 250)",
  brand: "oklch(0.5 0.12 152)",
  "brand-hover": "oklch(0.44 0.11 152)",
  "on-brand": "oklch(1 0 0)",
  "brand-fg": "oklch(0.42 0.1 152)",
  "brand-soft": "oklch(0.965 0.03 152)",
  "brand-edge": "oklch(0.87 0.07 152)",
  "brand-dot": "oklch(0.6 0.15 152)",
  "warn-fg": "oklch(0.45 0.1 70)",
  "warn-soft": "oklch(0.97 0.04 85)",
  "warn-edge": "oklch(0.85 0.09 80)",
  "warn-dot": "oklch(0.66 0.15 70)",
  danger: "oklch(0.5 0.19 25)",
  "danger-hover": "oklch(0.44 0.18 25)",
  "on-danger": "oklch(1 0 0)",
  "danger-fg": "oklch(0.48 0.17 25)",
  "danger-soft": "oklch(0.97 0.02 20)",
  "danger-edge": "oklch(0.86 0.07 22)",
  "danger-dot": "oklch(0.58 0.2 25)",
  "info-fg": "oklch(0.45 0.15 255)",
  "info-soft": "oklch(0.965 0.02 255)",
  "info-edge": "oklch(0.86 0.05 255)",
  "info-dot": "oklch(0.58 0.18 255)",
  "neutral-dot": "oklch(0.6 0.008 250)",
  "code-bg": "oklch(0.975 0.003 250)",
  "diff-add": "oklch(0.96 0.04 152)",
  "diff-del": "oklch(0.965 0.03 22)",
  "chart-2xx": "oklch(0.62 0.14 152)",
  "chart-3xx": "oklch(0.62 0.12 240)",
  "chart-4xx": "oklch(0.66 0.15 65)",
  "chart-5xx": "oklch(0.6 0.2 25)",
  "chart-other": "oklch(0.6 0.008 250)",
  "chart-series": "oklch(0.55 0.1 270)",
  scrim: "oklch(0.2 0.01 250 / 0.4)",
} satisfies ColorTheme;

/** Each type step: size and line height in px, weight, tracking in em. */
export interface TypeStep {
  size: number;
  line: number;
  weight: number;
  tracking: number;
  use: string;
}

export const typeScale = {
  xs: { size: 12, line: 16, weight: 500, tracking: 0, use: "Captions, keycaps, dense meta" },
  sm: { size: 13, line: 20, weight: 400, tracking: -0.006, use: "Labels, helper text, table meta" },
  base: { size: 14, line: 20, weight: 400, tracking: -0.006, use: "Body, controls, table cells" },
  md: { size: 15, line: 22, weight: 600, tracking: -0.012, use: "Section titles" },
  lg: { size: 18, line: 26, weight: 600, tracking: -0.02, use: "Dialog and panel titles" },
  xl: { size: 24, line: 32, weight: 600, tracking: -0.03, use: "Page titles on small screens" },
  "2xl": { size: 28, line: 36, weight: 600, tracking: -0.035, use: "Page titles" },
  metric: { size: 36, line: 40, weight: 600, tracking: -0.04, use: "KPI numbers (tabular figures)" },
} satisfies Record<string, TypeStep>;

export const fonts = {
  sans: '"Geist Variable", "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"Geist Mono Variable", "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

/** Tailwind's 4px grid. Named here so the docs and TS agree with `--spacing`. */
export const spacing = {
  base: 4,
  steps: [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16],
  layout: { gutter: 16, page: 24, section: 24 },
} as const;

export const radius = {
  sm: { px: 4, use: "Keycaps, checkbox, inline chips" },
  md: { px: 6, use: "Buttons, tabs, menu items" },
  lg: { px: 8, use: "Inputs, cards, popovers" },
  xl: { px: 12, use: "Dialogs, toasts" },
  full: { px: 9999, use: "Badges, status pills, switch" },
} as const;

export const border = {
  hairline: { px: 1, use: "Every divider, card and control edge" },
  focus: { px: 2, use: "Focus ring and the active tab rule" },
} as const;

export const shadow = {
  dark: {
    raised: "0 1px 2px oklch(0 0 0 / 0.4)",
    popover: "0 8px 24px oklch(0 0 0 / 0.5), 0 0 0 1px oklch(0.39 0.012 255)",
    dialog: "0 16px 48px oklch(0 0 0 / 0.6), 0 0 0 1px oklch(0.39 0.012 255)",
  },
  light: {
    raised: "0 1px 2px oklch(0.2 0.01 250 / 0.06)",
    popover: "0 8px 24px oklch(0.2 0.01 250 / 0.12), 0 0 0 1px oklch(0.83 0.005 250)",
    dialog: "0 16px 48px oklch(0.2 0.01 250 / 0.18), 0 0 0 1px oklch(0.83 0.005 250)",
  },
} as const;

export const motion = {
  duration: { fast: 100, base: 150, slow: 250 },
  easing: {
    standard: "cubic-bezier(0.2, 0, 0, 1)",
    exit: "cubic-bezier(0.4, 0, 1, 1)",
  },
} as const;

export const zIndex = {
  base: 0,
  sticky: 20,
  dropdown: 40,
  overlay: 50,
  modal: 60,
  popover: 70,
  toast: 80,
  tooltip: 90,
} as const;

export const breakpoints = {
  sm: { rem: 40, use: "Large phones, landscape" },
  md: { rem: 48, use: "Tablets, sidebar becomes a rail" },
  lg: { rem: 64, use: "Laptops, sidebar fully open" },
  xl: { rem: 80, use: "Desktops" },
  "2xl": { rem: 96, use: "Wide screens, content stops growing at 1280px" },
} as const;

/** Density only changes control and row height; type size never changes. */
export const density = {
  comfortable: { control: 36, controlSm: 28, row: 48 },
  compact: { control: 32, controlSm: 24, row: 36 },
} as const;

export type DensityName = keyof typeof density;
