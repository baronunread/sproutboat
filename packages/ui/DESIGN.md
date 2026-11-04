# Sproutboat design system

`@sproutboat/ui` is the open component package behind the Community dashboard and, later, the Cloud dashboard. This file is the contract: the principles, every token, and the rules for using them. Tokens live in `tokens/tokens.ts`; the tables below are generated from that file by `bun run --cwd packages/ui tokens`, so they cannot drift from the code.

## Principles

1. **Quiet by default.** Monochrome hairlines, near-white and near-black surfaces, one typeface family. Color is rare, so when it appears it means something.
2. **One brand green, two jobs.** Green marks a primary action or a success. It never decorates, and it is never the only signal.
3. **Amber is not red.** A version that fell back to the supervisor is working, only differently. It is amber. Red is reserved for errors that need action and for destructive controls.
4. **Status is dot plus word.** Every status shows a shape and a label. Color alone is never the message.
5. **Dense but readable.** 14px body, 36px controls, 48px table rows. Density changes sizes of boxes, never type.
6. **Borders, not shadows.** Separation comes from 1px hairlines and a slightly lighter surface. Only floating layers (menus, dialogs, toasts) get a shadow.
7. **Keyboard first.** Every control is reachable, shows a focus ring, and works with the keys its WAI-ARIA pattern promises.
8. **Calm motion.** Short fades and small slides, zeroed when the reader asks for reduced motion.
9. **Logical, not physical.** Components use `start`/`end`, `ps-*`/`pe-*` and `inline` utilities so right-to-left works without forks.

## Theming convention

Compatible with `apps/web`: dark is the default, light opts in with `data-theme="light"` on `<html>`, and a boot script stamps the attribute before first paint. The attribute is always `light` or `dark`; "system" is resolved by the boot script against `prefers-color-scheme`. The `dark:` Tailwind variant means "not light", exactly as in `apps/web/src/app.css`. `theme.css` sets `color-scheme` per theme so native controls and scrollbars follow.

```css
@import "tailwindcss";
@import "@sproutboat/ui/theme.css";
@source "../node_modules/@sproutboat/ui/src";
```

The package ships Geist Sans and Geist Mono as the intended faces. Apps load them (`@fontsource-variable/geist`, `@fontsource-variable/geist-mono`); the stacks fall back to system fonts.

## Color

All colors are OKLCH, defined once per theme and exposed as `--sb-*` variables plus Tailwind utilities (`bg-surface`, `text-fg-muted`, `border-hairline`). Components only use semantic tokens, never raw values.

<!-- tokens:palette:start -->

| Token             | Tailwind utility                                                     | Dark                     | Light                       |
| ----------------- | -------------------------------------------------------------------- | ------------------------ | --------------------------- |
| `canvas`          | `bg-canvas` `text-canvas` `border-canvas`                            | `oklch(0.155 0.006 255)` | `oklch(0.982 0.002 250)`    |
| `surface`         | `bg-surface` `text-surface` `border-surface`                         | `oklch(0.195 0.008 255)` | `oklch(1 0 0)`              |
| `raised`          | `bg-raised` `text-raised` `border-raised`                            | `oklch(0.235 0.01 255)`  | `oklch(0.963 0.003 250)`    |
| `hairline`        | `bg-hairline` `text-hairline` `border-hairline`                      | `oklch(0.29 0.011 255)`  | `oklch(0.915 0.004 250)`    |
| `hairline-strong` | `bg-hairline-strong` `text-hairline-strong` `border-hairline-strong` | `oklch(0.39 0.012 255)`  | `oklch(0.83 0.005 250)`     |
| `control-edge`    | `bg-control-edge` `text-control-edge` `border-control-edge`          | `oklch(0.58 0.014 255)`  | `oklch(0.6 0.008 250)`      |
| `focus`           | `bg-focus` `text-focus` `border-focus`                               | `oklch(0.965 0.004 255)` | `oklch(0.2 0.005 250)`      |
| `fg`              | `bg-fg` `text-fg` `border-fg`                                        | `oklch(0.965 0.004 255)` | `oklch(0.2 0.005 250)`      |
| `fg-muted`        | `bg-fg-muted` `text-fg-muted` `border-fg-muted`                      | `oklch(0.76 0.012 255)`  | `oklch(0.47 0.008 250)`     |
| `brand`           | `bg-brand` `text-brand` `border-brand`                               | `oklch(0.8 0.17 150)`    | `oklch(0.5 0.12 152)`       |
| `brand-hover`     | `bg-brand-hover` `text-brand-hover` `border-brand-hover`             | `oklch(0.85 0.17 150)`   | `oklch(0.44 0.11 152)`      |
| `on-brand`        | `bg-on-brand` `text-on-brand` `border-on-brand`                      | `oklch(0.19 0.04 150)`   | `oklch(1 0 0)`              |
| `brand-fg`        | `bg-brand-fg` `text-brand-fg` `border-brand-fg`                      | `oklch(0.82 0.16 150)`   | `oklch(0.42 0.1 152)`       |
| `brand-soft`      | `bg-brand-soft` `text-brand-soft` `border-brand-soft`                | `oklch(0.27 0.05 150)`   | `oklch(0.965 0.03 152)`     |
| `brand-edge`      | `bg-brand-edge` `text-brand-edge` `border-brand-edge`                | `oklch(0.38 0.08 150)`   | `oklch(0.87 0.07 152)`      |
| `brand-dot`       | `bg-brand-dot` `text-brand-dot` `border-brand-dot`                   | `oklch(0.8 0.17 150)`    | `oklch(0.6 0.15 152)`       |
| `warn-fg`         | `bg-warn-fg` `text-warn-fg` `border-warn-fg`                         | `oklch(0.85 0.14 82)`    | `oklch(0.45 0.1 70)`        |
| `warn-soft`       | `bg-warn-soft` `text-warn-soft` `border-warn-soft`                   | `oklch(0.27 0.05 80)`    | `oklch(0.97 0.04 85)`       |
| `warn-edge`       | `bg-warn-edge` `text-warn-edge` `border-warn-edge`                   | `oklch(0.42 0.08 80)`    | `oklch(0.85 0.09 80)`       |
| `warn-dot`        | `bg-warn-dot` `text-warn-dot` `border-warn-dot`                      | `oklch(0.82 0.16 80)`    | `oklch(0.66 0.15 70)`       |
| `danger`          | `bg-danger` `text-danger` `border-danger`                            | `oklch(0.72 0.17 25)`    | `oklch(0.5 0.19 25)`        |
| `danger-hover`    | `bg-danger-hover` `text-danger-hover` `border-danger-hover`          | `oklch(0.77 0.16 25)`    | `oklch(0.44 0.18 25)`       |
| `on-danger`       | `bg-on-danger` `text-on-danger` `border-on-danger`                   | `oklch(0.18 0.04 25)`    | `oklch(1 0 0)`              |
| `danger-fg`       | `bg-danger-fg` `text-danger-fg` `border-danger-fg`                   | `oklch(0.78 0.15 25)`    | `oklch(0.48 0.17 25)`       |
| `danger-soft`     | `bg-danger-soft` `text-danger-soft` `border-danger-soft`             | `oklch(0.26 0.06 25)`    | `oklch(0.97 0.02 20)`       |
| `danger-edge`     | `bg-danger-edge` `text-danger-edge` `border-danger-edge`             | `oklch(0.42 0.1 25)`     | `oklch(0.86 0.07 22)`       |
| `danger-dot`      | `bg-danger-dot` `text-danger-dot` `border-danger-dot`                | `oklch(0.72 0.17 25)`    | `oklch(0.58 0.2 25)`        |
| `info-fg`         | `bg-info-fg` `text-info-fg` `border-info-fg`                         | `oklch(0.8 0.1 245)`     | `oklch(0.45 0.15 255)`      |
| `info-soft`       | `bg-info-soft` `text-info-soft` `border-info-soft`                   | `oklch(0.26 0.04 250)`   | `oklch(0.965 0.02 255)`     |
| `info-edge`       | `bg-info-edge` `text-info-edge` `border-info-edge`                   | `oklch(0.4 0.07 250)`    | `oklch(0.86 0.05 255)`      |
| `info-dot`        | `bg-info-dot` `text-info-dot` `border-info-dot`                      | `oklch(0.75 0.13 245)`   | `oklch(0.58 0.18 255)`      |
| `neutral-dot`     | `bg-neutral-dot` `text-neutral-dot` `border-neutral-dot`             | `oklch(0.62 0.012 255)`  | `oklch(0.6 0.008 250)`      |
| `code-bg`         | `bg-code-bg` `text-code-bg` `border-code-bg`                         | `oklch(0.17 0.007 255)`  | `oklch(0.975 0.003 250)`    |
| `diff-add`        | `bg-diff-add` `text-diff-add` `border-diff-add`                      | `oklch(0.25 0.05 150)`   | `oklch(0.96 0.04 152)`      |
| `diff-del`        | `bg-diff-del` `text-diff-del` `border-diff-del`                      | `oklch(0.25 0.05 22)`    | `oklch(0.965 0.03 22)`      |
| `chart-2xx`       | `bg-chart-2xx` `text-chart-2xx` `border-chart-2xx`                   | `oklch(0.78 0.16 150)`   | `oklch(0.62 0.14 152)`      |
| `chart-3xx`       | `bg-chart-3xx` `text-chart-3xx` `border-chart-3xx`                   | `oklch(0.76 0.1 240)`    | `oklch(0.62 0.12 240)`      |
| `chart-4xx`       | `bg-chart-4xx` `text-chart-4xx` `border-chart-4xx`                   | `oklch(0.82 0.15 75)`    | `oklch(0.66 0.15 65)`       |
| `chart-5xx`       | `bg-chart-5xx` `text-chart-5xx` `border-chart-5xx`                   | `oklch(0.7 0.18 25)`     | `oklch(0.6 0.2 25)`         |
| `chart-other`     | `bg-chart-other` `text-chart-other` `border-chart-other`             | `oklch(0.62 0.012 255)`  | `oklch(0.6 0.008 250)`      |
| `chart-series`    | `bg-chart-series` `text-chart-series` `border-chart-series`          | `oklch(0.76 0.1 285)`    | `oklch(0.55 0.1 270)`       |
| `scrim`           | `bg-scrim` `text-scrim` `border-scrim`                               | `oklch(0 0 0 / 0.6)`     | `oklch(0.2 0.01 250 / 0.4)` |

<!-- tokens:palette:end -->

### Contrast

Every pair below is asserted by `test/tokens.test.ts`. Text needs 4.5:1, large text (18px or 14px bold) and UI parts (control edges, dots, rings, fills) need 3:1. The ratios are computed from the OKLCH values with WCAG 2.x relative luminance.

<!-- tokens:contrast:start -->

| Foreground     | Background     | Needs        | Dark         | Light        | Used for                                  |
| -------------- | -------------- | ------------ | ------------ | ------------ | ----------------------------------------- |
| `fg`           | `canvas`       | 4.5:1 (text) | 17.66:1 pass | 17.19:1 pass | Body text                                 |
| `fg`           | `surface`      | 4.5:1 (text) | 16.52:1 pass | 18.10:1 pass | Body text                                 |
| `fg`           | `raised`       | 4.5:1 (text) | 15.06:1 pass | 16.26:1 pass | Body text                                 |
| `fg-muted`     | `canvas`       | 4.5:1 (text) | 9.11:1 pass  | 6.48:1 pass  | Secondary text, placeholders              |
| `fg-muted`     | `surface`      | 4.5:1 (text) | 8.52:1 pass  | 6.82:1 pass  | Secondary text, placeholders              |
| `fg-muted`     | `raised`       | 4.5:1 (text) | 7.77:1 pass  | 6.13:1 pass  | Secondary text, placeholders              |
| `fg`           | `code-bg`      | 4.5:1 (text) | 17.28:1 pass | 16.84:1 pass | Code and log text                         |
| `fg-muted`     | `code-bg`      | 4.5:1 (text) | 8.91:1 pass  | 6.35:1 pass  | Log timestamps                            |
| `fg`           | `diff-add`     | 4.5:1 (text) | 14.23:1 pass | 16.34:1 pass | Added line                                |
| `fg`           | `diff-del`     | 4.5:1 (text) | 14.70:1 pass | 15.91:1 pass | Removed line                              |
| `on-brand`     | `brand`        | 4.5:1 (text) | 10.44:1 pass | 5.67:1 pass  | Primary button label                      |
| `on-brand`     | `brand-hover`  | 4.5:1 (text) | 12.30:1 pass | 7.37:1 pass  | Primary button label, hover               |
| `on-danger`    | `danger`       | 4.5:1 (text) | 7.10:1 pass  | 6.63:1 pass  | Destructive button label                  |
| `on-danger`    | `danger-hover` | 4.5:1 (text) | 8.15:1 pass  | 8.50:1 pass  | Destructive button label, hover           |
| `brand-fg`     | `surface`      | 4.5:1 (text) | 11.10:1 pass | 8.07:1 pass  | brand text on surface                     |
| `brand-fg`     | `canvas`       | 4.5:1 (text) | 11.87:1 pass | 7.66:1 pass  | brand text on canvas                      |
| `brand-fg`     | `brand-soft`   | 4.5:1 (text) | 8.99:1 pass  | 7.37:1 pass  | brand badge                               |
| `warn-fg`      | `surface`      | 4.5:1 (text) | 11.44:1 pass | 7.61:1 pass  | warn text on surface                      |
| `warn-fg`      | `canvas`       | 4.5:1 (text) | 12.23:1 pass | 7.22:1 pass  | warn text on canvas                       |
| `warn-fg`      | `warn-soft`    | 4.5:1 (text) | 9.47:1 pass  | 6.93:1 pass  | warn badge                                |
| `danger-fg`    | `surface`      | 4.5:1 (text) | 8.24:1 pass  | 7.15:1 pass  | danger text on surface                    |
| `danger-fg`    | `canvas`       | 4.5:1 (text) | 8.81:1 pass  | 6.79:1 pass  | danger text on canvas                     |
| `danger-fg`    | `danger-soft`  | 4.5:1 (text) | 7.15:1 pass  | 6.46:1 pass  | danger badge                              |
| `info-fg`      | `surface`      | 4.5:1 (text) | 9.88:1 pass  | 7.54:1 pass  | info text on surface                      |
| `info-fg`      | `canvas`       | 4.5:1 (text) | 10.56:1 pass | 7.16:1 pass  | info text on canvas                       |
| `info-fg`      | `info-soft`    | 4.5:1 (text) | 8.39:1 pass  | 6.81:1 pass  | info badge                                |
| `danger-fg`    | `surface`      | 3:1 (large)  | 8.24:1 pass  | 7.15:1 pass  | Danger zone heading                       |
| `control-edge` | `surface`      | 3:1 (ui)     | 4.27:1 pass  | 3.94:1 pass  | Input, select, checkbox edge              |
| `focus`        | `surface`      | 3:1 (ui)     | 16.52:1 pass | 18.10:1 pass | Focus ring                                |
| `brand`        | `surface`      | 3:1 (ui)     | 10.42:1 pass | 5.67:1 pass  | Switch on, checkbox checked, primary fill |
| `brand-dot`    | `surface`      | 3:1 (ui)     | 10.42:1 pass | 3.69:1 pass  | Success dot                               |
| `warn-dot`     | `surface`      | 3:1 (ui)     | 10.30:1 pass | 3.20:1 pass  | Fallback and warning dot                  |
| `danger-dot`   | `surface`      | 3:1 (ui)     | 6.84:1 pass  | 4.74:1 pass  | Error dot                                 |
| `info-dot`     | `surface`      | 3:1 (ui)     | 8.31:1 pass  | 4.34:1 pass  | Info dot                                  |
| `neutral-dot`  | `surface`      | 3:1 (ui)     | 5.02:1 pass  | 3.94:1 pass  | Idle and unknown dot                      |
| `control-edge` | `canvas`       | 3:1 (ui)     | 4.57:1 pass  | 3.75:1 pass  | Input, select, checkbox edge              |
| `focus`        | `canvas`       | 3:1 (ui)     | 17.66:1 pass | 17.19:1 pass | Focus ring                                |
| `brand`        | `canvas`       | 3:1 (ui)     | 11.14:1 pass | 5.38:1 pass  | Switch on, checkbox checked, primary fill |
| `brand-dot`    | `canvas`       | 3:1 (ui)     | 11.14:1 pass | 3.51:1 pass  | Success dot                               |
| `warn-dot`     | `canvas`       | 3:1 (ui)     | 11.01:1 pass | 3.04:1 pass  | Fallback and warning dot                  |
| `danger-dot`   | `canvas`       | 3:1 (ui)     | 7.31:1 pass  | 4.50:1 pass  | Error dot                                 |
| `info-dot`     | `canvas`       | 3:1 (ui)     | 8.88:1 pass  | 4.12:1 pass  | Info dot                                  |
| `neutral-dot`  | `canvas`       | 3:1 (ui)     | 5.37:1 pass  | 3.75:1 pass  | Idle and unknown dot                      |
| `focus`        | `raised`       | 3:1 (ui)     | 15.06:1 pass | 16.26:1 pass | Focus ring on raised                      |
| `danger`       | `surface`      | 3:1 (ui)     | 6.84:1 pass  | 6.63:1 pass  | Destructive button fill                   |
| `chart-2xx`    | `surface`      | 3:1 (ui)     | 9.71:1 pass  | 3.42:1 pass  | Chart mark                                |
| `chart-3xx`    | `surface`      | 3:1 (ui)     | 8.64:1 pass  | 3.58:1 pass  | Chart mark                                |
| `chart-4xx`    | `surface`      | 3:1 (ui)     | 10.26:1 pass | 3.23:1 pass  | Chart mark                                |
| `chart-5xx`    | `surface`      | 3:1 (ui)     | 6.31:1 pass  | 4.36:1 pass  | Chart mark                                |
| `chart-other`  | `surface`      | 3:1 (ui)     | 5.02:1 pass  | 3.94:1 pass  | Chart mark                                |
| `chart-series` | `surface`      | 3:1 (ui)     | 8.33:1 pass  | 4.93:1 pass  | Chart mark                                |

<!-- tokens:contrast:end -->

Hairlines are decorative dividers and are deliberately below 3:1. They never carry meaning on their own. Anything that identifies a control (input, select, checkbox, switch) uses `control-edge`, which clears 3:1.

<!-- tokens:decorative:start -->

| Hairline          | Against   | Dark   | Light  |
| ----------------- | --------- | ------ | ------ |
| `hairline`        | `canvas`  | 1.39:1 | 1.22:1 |
| `hairline`        | `surface` | 1.30:1 | 1.29:1 |
| `hairline-strong` | `surface` | 1.91:1 | 1.69:1 |

<!-- tokens:decorative:end -->

### Using status colors

| Meaning                 | Family                       | Use for                                                                 | Never use for                                    |
| ----------------------- | ---------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| Success, primary action | `brand`                      | Primary button, ready or healthy state, success toast, checked controls | Decoration, links, charts with no status meaning |
| Degraded but working    | `warn` (amber)               | "Fell back to supervisor", usage near its limit, deprecations           | Errors, anything that blocks the user            |
| Failure needing action  | `danger`                     | Failed deploy, validation errors, destructive buttons, the danger zone  | Fallback, warnings, emphasis                     |
| Neutral information     | `info`                       | Notices, links to docs, in-progress states                              | Success or failure                               |
| Idle, unknown, off      | `neutral-dot` and `fg-muted` | Stopped, no data, disabled                                              | Anything with a deadline                         |

Rules:

- Pair every status with a label. `StatusDot` and `Badge` require visible text or an `aria-label`.
- Text on a status background uses the `*-fg` token on `*-soft`. Solid fills (`brand`, `danger`) take `on-brand` and `on-danger`.
- Chart colors follow HTTP classes: green 2xx, blue 3xx, orange 4xx, red 5xx, grey other. A single series uses `chart-series`.
- One `brand` button per view. If two actions compete, one is `secondary`.

## Typography

Geist Sans for UI, Geist Mono for ids, hashes, keys and logs. Numbers in tables and tiles use tabular figures (`tabular-nums`). Body copy never goes below 13px; 12px is for captions and keycaps only.

<!-- tokens:type:start -->

| Step     | Size / line | Weight | Tracking | Utility       | Use                             |
| -------- | ----------- | ------ | -------- | ------------- | ------------------------------- |
| `xs`     | 12px / 16px | 500    | 0em      | `text-xs`     | Captions, keycaps, dense meta   |
| `sm`     | 13px / 20px | 400    | -0.006em | `text-sm`     | Labels, helper text, table meta |
| `base`   | 14px / 20px | 400    | -0.006em | `text-base`   | Body, controls, table cells     |
| `md`     | 15px / 22px | 600    | -0.012em | `text-md`     | Section titles                  |
| `lg`     | 18px / 26px | 600    | -0.02em  | `text-lg`     | Dialog and panel titles         |
| `xl`     | 24px / 32px | 600    | -0.03em  | `text-xl`     | Page titles on small screens    |
| `2xl`    | 28px / 36px | 600    | -0.035em | `text-2xl`    | Page titles                     |
| `metric` | 36px / 40px | 600    | -0.04em  | `text-metric` | KPI numbers (tabular figures)   |

<!-- tokens:type:end -->

Inputs use at least 16px on touch devices to prevent iOS zoom; the `Input` component switches to `text-[16px]` under `pointer-coarse`.

## Spacing

Tailwind's 4px grid (`--spacing: 0.25rem`). Layout gutters are 16px, page padding and section gaps 24px.

<!-- tokens:spacing:start -->

| Step | Utility example | Pixels |
| ---- | --------------- | ------ |
| 0    | `p-0` `gap-0`   | 0px    |
| 1    | `p-1` `gap-1`   | 4px    |
| 2    | `p-2` `gap-2`   | 8px    |
| 3    | `p-3` `gap-3`   | 12px   |
| 4    | `p-4` `gap-4`   | 16px   |
| 5    | `p-5` `gap-5`   | 20px   |
| 6    | `p-6` `gap-6`   | 24px   |
| 8    | `p-8` `gap-8`   | 32px   |
| 10   | `p-10` `gap-10` | 40px   |
| 12   | `p-12` `gap-12` | 48px   |
| 16   | `p-16` `gap-16` | 64px   |

<!-- tokens:spacing:end -->

## Radius and borders

<!-- tokens:radius:start -->

| Token  | Utility        | Size | Use                             |
| ------ | -------------- | ---- | ------------------------------- |
| `sm`   | `rounded-sm`   | 4px  | Keycaps, checkbox, inline chips |
| `md`   | `rounded-md`   | 6px  | Buttons, tabs, menu items       |
| `lg`   | `rounded-lg`   | 8px  | Inputs, cards, popovers         |
| `xl`   | `rounded-xl`   | 12px | Dialogs, toasts                 |
| `full` | `rounded-full` | pill | Badges, status pills, switch    |

<!-- tokens:radius:end -->

<!-- tokens:border:start -->

| Token      | Width | Use                                  |
| ---------- | ----- | ------------------------------------ |
| `hairline` | 1px   | Every divider, card and control edge |
| `focus`    | 2px   | Focus ring and the active tab rule   |

<!-- tokens:border:end -->

## Shadow and elevation

Three levels. Page content has none. `raised` is for sticky bars. `popover` is for menus, selects, tooltips and popovers. `dialog` is for dialogs and toasts. Floating layers also carry a 1px edge inside the shadow value, so they stay visible on near-black.

<!-- tokens:shadow:start -->

| Token     | Utility          | Dark                                                              | Light                                                                     |
| --------- | ---------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `raised`  | `shadow-raised`  | `0 1px 2px oklch(0 0 0 / 0.4)`                                    | `0 1px 2px oklch(0.2 0.01 250 / 0.06)`                                    |
| `popover` | `shadow-popover` | `0 8px 24px oklch(0 0 0 / 0.5), 0 0 0 1px oklch(0.39 0.012 255)`  | `0 8px 24px oklch(0.2 0.01 250 / 0.12), 0 0 0 1px oklch(0.83 0.005 250)`  |
| `dialog`  | `shadow-dialog`  | `0 16px 48px oklch(0 0 0 / 0.6), 0 0 0 1px oklch(0.39 0.012 255)` | `0 16px 48px oklch(0.2 0.01 250 / 0.18), 0 0 0 1px oklch(0.83 0.005 250)` |

<!-- tokens:shadow:end -->

## Motion

Transitions use `ease-standard` over `--sb-duration-*`. Enter and exit use 150ms (`base`); hover and press feedback use 100ms (`fast`). Only `opacity`, `transform` and colors animate. Never animate layout.

Reduced motion: when `prefers-reduced-motion: reduce` is set, `theme.css` sets every duration token to 0ms, so all state changes are instant. The spinner and the skeleton pulse are wrapped in `motion-safe:`, and the loading button keeps its `aria-busy` state and a static icon.

<!-- tokens:motion:start -->

| Token                | Value                        | Reduced motion          |
| -------------------- | ---------------------------- | ----------------------- |
| `--sb-duration-fast` | 100ms                        | 0ms                     |
| `--sb-duration-base` | 150ms                        | 0ms                     |
| `--sb-duration-slow` | 250ms                        | 0ms                     |
| `ease-standard`      | `cubic-bezier(0.2, 0, 0, 1)` | unchanged (no duration) |
| `ease-exit`          | `cubic-bezier(0.4, 0, 1, 1)` | unchanged (no duration) |

<!-- tokens:motion:end -->

## Z-index layers

Use the variables, never raw numbers: `z-(--sb-z-popover)`. Floating layers portal to `body`, so stacking contexts in the page cannot trap them.

<!-- tokens:zindex:start -->

| Layer    | Variable          | Value |
| -------- | ----------------- | ----- |
| base     | `--sb-z-base`     | 0     |
| sticky   | `--sb-z-sticky`   | 20    |
| dropdown | `--sb-z-dropdown` | 40    |
| overlay  | `--sb-z-overlay`  | 50    |
| modal    | `--sb-z-modal`    | 60    |
| popover  | `--sb-z-popover`  | 70    |
| toast    | `--sb-z-toast`    | 80    |
| tooltip  | `--sb-z-tooltip`  | 90    |

<!-- tokens:zindex:end -->

## Breakpoints

Mobile first. The two checked widths are 390px (a phone) and 1440px (a desktop).

<!-- tokens:breakpoints:start -->

| Name   | Min width      | Use                                           |
| ------ | -------------- | --------------------------------------------- |
| `sm:`  | 40rem (640px)  | Large phones, landscape                       |
| `md:`  | 48rem (768px)  | Tablets, sidebar becomes a rail               |
| `lg:`  | 64rem (1024px) | Laptops, sidebar fully open                   |
| `xl:`  | 80rem (1280px) | Desktops                                      |
| `2xl:` | 96rem (1536px) | Wide screens, content stops growing at 1280px |

<!-- tokens:breakpoints:end -->

## Density

Set `data-density="compact"` on any ancestor to shrink controls and table rows; the default is `comfortable`. Components read `--sb-control-h`, `--sb-control-h-sm` and `--sb-row-h`, so a dense table inside a comfortable page works. Density never changes type size, focus ring width, or the hit area on touch screens: under `pointer-coarse` the minimum control height is 44px whatever the density.

<!-- tokens:density:start -->

| Density       | Control | Small control | Table row |
| ------------- | ------- | ------------- | --------- |
| `comfortable` | 36px    | 28px          | 48px      |
| `compact`     | 32px    | 24px          | 36px      |

<!-- tokens:density:end -->

Use compact for log viewers, resource tables with many rows, and panels the user scans. Use comfortable for forms, settings and onboarding.

## Focus rings

- Every focusable element shows a 2px ring in `focus` (near-black in light, near-white in dark), offset 2px, on `:focus-visible` only. Mouse clicks do not draw a ring; keyboard and programmatic focus do.
- The ring is an outline, so it is not clipped by `overflow: hidden` on the control. Inside a clipped scroller (tab lists, menus) use a negative offset (`-outline-offset-2`).
- Never remove an outline without replacing it. Never rely on color change of the background alone.
- Invalid fields keep the same ring and add a `danger` edge plus an error message wired through `aria-describedby`.
- The ring must clear 3:1 against every surface it sits on; the contrast table covers `canvas`, `surface` and `raised`.

## Component rules

- Every component takes `className` (merged with `tailwind-merge`, so callers win) and a `ref` (React 19 ref prop, no `forwardRef` wrapper).
- States are covered through Base UI data attributes (`data-open`, `data-checked`, `data-disabled`, `data-invalid`) and `aria-*`, not through extra props.
- Icon-only controls require `label`, which becomes `aria-label` and the tooltip text.
- Loading disables interaction with `aria-busy` and `data-loading`, but keeps the button's width so nothing shifts.
- Positioned layers (Tooltip, Popover, Menu, Select) flip and shift inside the viewport and use `collisionPadding`.
- Dialogs trap focus, restore it on close, and close on Escape. Destructive dialogs focus the cancel action first.
- Copy follows the product voice: sentence case, verb first on buttons ("Create project", never "Submit"), errors say what to do next.

## Adding or changing a token

1. Edit `tokens/tokens.ts`. If it is a color used as text or UI, add or update its pair in `tokens/pairs.ts`.
2. Run `bun run --cwd packages/ui tokens`.
3. Run `bun test packages/ui/test`. The contrast and drift tests must pass.
