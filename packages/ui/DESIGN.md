# Sproutboat design system

`@sproutboat/ui` is the open component package behind the Community dashboard and, later, the Cloud dashboard. This file is the contract: the principles, every token, and the rules for using them. Tokens live in `tokens/tokens.ts`; the tables below are generated from that file by `bun run --cwd packages/ui tokens`, so they cannot drift from the code.

## Principles

1. **Soft, layered.** Surfaces separate by a gentle step in tone and a layered shadow, not by borders everywhere. Canvas, surface, well and raised each sit one step apart. Hairlines are kept for table rules and dividers.
2. **Concentric radii.** Outer radius = inner radius + padding: controls 8, a well 10 (rows 6 inside it), cards, menus and dialogs 12.
3. **Green is rare.** Sprout green (hue about 150) appears only on primary actions and success. Focus is neutral ink, never green. Everything else is neutral grey or a status color that stays well away from it.
4. **Amber is not red.** A version that fell back to the supervisor is working, only differently. It is amber. Red is reserved for errors that need action and for destructive controls.
5. **Status is shape plus word.** Every status shows its own shape (circle, triangle, cross, ring, square) and a label. Color alone is never the message.
6. **Overlays are clearly raised.** Menus, selects, popovers, dialogs and toasts use the lighter `raised` surface with a layered shadow, in dark as well as light.
7. **Dense but readable.** 14px body, 36px controls, 48px table rows. Density changes sizes of boxes, never type.
8. **Keyboard first.** Every control is reachable, shows a neutral focus ring, and works with the keys its WAI-ARIA pattern promises. Overlays opened with the keyboard do not animate.
9. **Motion with a reason.** Ease-out for everything that enters or is pressed, short exits, nothing below scale 0.96. Reduced motion keeps fades and drops movement.
10. **Logical, not physical.** Components use `start`/`end`, `ps-*`/`pe-*` and `inline` utilities so right-to-left works without forks.

## Theming convention

Compatible with `apps/web`: dark is the default, light opts in with `data-theme="light"` on `<html>`, and a boot script stamps the attribute before first paint. The attribute is always `light` or `dark`; "system" is resolved by the boot script against `prefers-color-scheme`. The `dark:` Tailwind variant means "not light", exactly as in `apps/web/src/app.css`. `theme.css` sets `color-scheme` per theme so native controls and scrollbars follow.

```css
@import "tailwindcss";
@import "@sproutboat/ui/theme.css";
@source "../node_modules/@sproutboat/ui/src";
```

The package ships Figtree and JetBrains Mono as the intended faces. Apps load them (`@fontsource-variable/figtree`, `@fontsource-variable/jetbrains-mono`); the stacks fall back to system fonts.

Nested `data-theme` scopes work: put `data-theme="light"` on any element and every token below re-scopes inside it. Wrap that element in `PortalContainer` so menus, selects, popovers and dialogs mount inside the scope and take its theme (the playground shows both themes side by side this way).

## Color

All colors are OKLCH, defined once per theme and exposed as `--sb-*` variables plus Tailwind utilities (`bg-surface`, `text-fg-muted`, `border-hairline`). Components only use semantic tokens, never raw values.

**Light** surfaces are neutral grey with chroma near zero (canvas 0.965, surface 0.995, well 0.962, hover 0.925, raised white). **Dark** surfaces are a cool slate graphite (hue 255, chroma 0.014 to 0.02): canvas 0.18, well 0.20, surface 0.23, hover 0.295 and raised 0.34, so an overlay is a clear step above the card under it. In dark the accent buttons are a little quieter than a plain sheet would make them (L 0.72, C 0.12 against 0.78 and 0.15, label contrast still above 7:1).

### Why this palette

The colour survey (`mockups-20261104/color-survey/SURVEY.md`) measured 20-odd cloud and deploy platforms. Two findings decided this. Green and teal is the most crowded family, and it is clustered: Supabase, Neon, Deno Deploy, Koyeb and Northflank all sit within 8 degrees of hue 157 to 163, and most of them are databases or runtimes whose green is their logo. A green UI would read as "a database". And deploy platforms are near-monochrome: Vercel has no chromatic accent, Render and Cloudflare docs keep one accent for the call to action and links. So Sproutboat keeps its sprout hue but changes its role: a neutral UI where the product is the content, with green only on primary actions and success. Status colors (amber, red, blue, grey) are chosen at least 45 degrees from the accent, and a test enforces it.

<!-- tokens:palette:start -->

| Token             | Tailwind utility                                                     | Dark                           | Light                      |
| ----------------- | -------------------------------------------------------------------- | ------------------------------ | -------------------------- |
| `canvas`          | `bg-canvas` `text-canvas` `border-canvas`                            | `oklch(0.18 0.014 255)`        | `oklch(0.965 0 0)`         |
| `surface`         | `bg-surface` `text-surface` `border-surface`                         | `oklch(0.23 0.016 255)`        | `oklch(0.995 0 0)`         |
| `well`            | `bg-well` `text-well` `border-well`                                  | `oklch(0.2 0.015 255)`         | `oklch(0.962 0 0)`         |
| `hover`           | `bg-hover` `text-hover` `border-hover`                               | `oklch(0.295 0.018 255)`       | `oklch(0.925 0 0)`         |
| `raised`          | `bg-raised` `text-raised` `border-raised`                            | `oklch(0.34 0.02 255)`         | `oklch(1 0 0)`             |
| `hairline`        | `bg-hairline` `text-hairline` `border-hairline`                      | `oklch(0.3 0.018 255)`         | `oklch(0.9 0 0)`           |
| `hairline-strong` | `bg-hairline-strong` `text-hairline-strong` `border-hairline-strong` | `oklch(0.4 0.02 255)`          | `oklch(0.82 0 0)`          |
| `control-edge`    | `bg-control-edge` `text-control-edge` `border-control-edge`          | `oklch(0.56 0.02 255)`         | `oklch(0.6 0 0)`           |
| `focus`           | `bg-focus` `text-focus` `border-focus`                               | `oklch(0.95 0.01 255)`         | `oklch(0.22 0 0)`          |
| `fg`              | `bg-fg` `text-fg` `border-fg`                                        | `oklch(0.95 0.01 255)`         | `oklch(0.22 0 0)`          |
| `fg-muted`        | `bg-fg-muted` `text-fg-muted` `border-fg-muted`                      | `oklch(0.76 0.018 255)`        | `oklch(0.44 0 0)`          |
| `brand`           | `bg-brand` `text-brand` `border-brand`                               | `oklch(0.72 0.12 152)`         | `oklch(0.47 0.12 152)`     |
| `brand-hover`     | `bg-brand-hover` `text-brand-hover` `border-brand-hover`             | `oklch(0.77 0.12 152)`         | `oklch(0.42 0.105 152)`    |
| `on-brand`        | `bg-on-brand` `text-on-brand` `border-on-brand`                      | `oklch(0.2 0.03 152)`          | `oklch(0.99 0.005 150)`    |
| `brand-fg`        | `bg-brand-fg` `text-brand-fg` `border-brand-fg`                      | `oklch(0.82 0.13 152)`         | `oklch(0.42 0.11 152)`     |
| `brand-soft`      | `bg-brand-soft` `text-brand-soft` `border-brand-soft`                | `oklch(0.31 0.045 152)`        | `oklch(0.94 0.05 150)`     |
| `brand-dot`       | `bg-brand-dot` `text-brand-dot` `border-brand-dot`                   | `oklch(0.74 0.15 152)`         | `oklch(0.62 0.16 150)`     |
| `warn-fg`         | `bg-warn-fg` `text-warn-fg` `border-warn-fg`                         | `oklch(0.88 0.1 85)`           | `oklch(0.43 0.09 70)`      |
| `warn-soft`       | `bg-warn-soft` `text-warn-soft` `border-warn-soft`                   | `oklch(0.35 0.06 80)`          | `oklch(0.95 0.06 85)`      |
| `warn-dot`        | `bg-warn-dot` `text-warn-dot` `border-warn-dot`                      | `oklch(0.8 0.14 80)`           | `oklch(0.63 0.14 72)`      |
| `danger`          | `bg-danger` `text-danger` `border-danger`                            | `oklch(0.68 0.14 25)`          | `oklch(0.48 0.18 25)`      |
| `danger-hover`    | `bg-danger-hover` `text-danger-hover` `border-danger-hover`          | `oklch(0.73 0.13 25)`          | `oklch(0.43 0.18 25)`      |
| `on-danger`       | `bg-on-danger` `text-on-danger` `border-on-danger`                   | `oklch(0.18 0.04 25)`          | `oklch(1 0 0)`             |
| `danger-fg`       | `bg-danger-fg` `text-danger-fg` `border-danger-fg`                   | `oklch(0.85 0.1 25)`           | `oklch(0.46 0.18 25)`      |
| `danger-soft`     | `bg-danger-soft` `text-danger-soft` `border-danger-soft`             | `oklch(0.34 0.08 25)`          | `oklch(0.95 0.035 25)`     |
| `danger-dot`      | `bg-danger-dot` `text-danger-dot` `border-danger-dot`                | `oklch(0.74 0.16 25)`          | `oklch(0.58 0.2 25)`       |
| `info-fg`         | `bg-info-fg` `text-info-fg` `border-info-fg`                         | `oklch(0.84 0.1 255)`          | `oklch(0.42 0.14 255)`     |
| `info-soft`       | `bg-info-soft` `text-info-soft` `border-info-soft`                   | `oklch(0.33 0.07 255)`         | `oklch(0.94 0.04 255)`     |
| `info-dot`        | `bg-info-dot` `text-info-dot` `border-info-dot`                      | `oklch(0.76 0.13 255)`         | `oklch(0.58 0.15 255)`     |
| `neutral-fg`      | `bg-neutral-fg` `text-neutral-fg` `border-neutral-fg`                | `oklch(0.85 0.012 255)`        | `oklch(0.42 0 0)`          |
| `neutral-soft`    | `bg-neutral-soft` `text-neutral-soft` `border-neutral-soft`          | `oklch(0.33 0.012 255)`        | `oklch(0.93 0 0)`          |
| `neutral-dot`     | `bg-neutral-dot` `text-neutral-dot` `border-neutral-dot`             | `oklch(0.72 0.012 255)`        | `oklch(0.55 0 0)`          |
| `code-bg`         | `bg-code-bg` `text-code-bg` `border-code-bg`                         | `oklch(0.155 0.012 255)`       | `oklch(0.955 0 0)`         |
| `diff-add`        | `bg-diff-add` `text-diff-add` `border-diff-add`                      | `oklch(0.27 0.05 152)`         | `oklch(0.94 0.05 150)`     |
| `diff-del`        | `bg-diff-del` `text-diff-del` `border-diff-del`                      | `oklch(0.27 0.06 25)`          | `oklch(0.95 0.04 25)`      |
| `chart-requests`  | `bg-chart-requests` `text-chart-requests` `border-chart-requests`    | `oklch(0.76 0.13 255)`         | `oklch(0.55 0.15 255)`     |
| `chart-errors`    | `bg-chart-errors` `text-chart-errors` `border-chart-errors`          | `oklch(0.74 0.16 25)`          | `oklch(0.58 0.2 25)`       |
| `chart-deploy`    | `bg-chart-deploy` `text-chart-deploy` `border-chart-deploy`          | `oklch(0.83 0.015 255)`        | `oklch(0.4 0 0)`           |
| `chart-grid`      | `bg-chart-grid` `text-chart-grid` `border-chart-grid`                | `oklch(0.34 0.018 255)`        | `oklch(0.88 0 0)`          |
| `chart-2xx`       | `bg-chart-2xx` `text-chart-2xx` `border-chart-2xx`                   | `oklch(0.76 0.16 152)`         | `oklch(0.6 0.16 150)`      |
| `chart-3xx`       | `bg-chart-3xx` `text-chart-3xx` `border-chart-3xx`                   | `oklch(0.78 0.1 235)`          | `oklch(0.6 0.12 235)`      |
| `chart-4xx`       | `bg-chart-4xx` `text-chart-4xx` `border-chart-4xx`                   | `oklch(0.8 0.13 80)`           | `oklch(0.62 0.135 75)`     |
| `chart-5xx`       | `bg-chart-5xx` `text-chart-5xx` `border-chart-5xx`                   | `oklch(0.74 0.16 25)`          | `oklch(0.58 0.2 25)`       |
| `chart-other`     | `bg-chart-other` `text-chart-other` `border-chart-other`             | `oklch(0.72 0.012 255)`        | `oklch(0.55 0 0)`          |
| `chart-series`    | `bg-chart-series` `text-chart-series` `border-chart-series`          | `oklch(0.76 0.1 300)`          | `oklch(0.55 0.12 300)`     |
| `scrim`           | `bg-scrim` `text-scrim` `border-scrim`                               | `oklch(0.06 0.012 255 / 0.62)` | `oklch(0.25 0 260 / 0.34)` |

<!-- tokens:palette:end -->

### Contrast

Every pair below is asserted by `test/tokens.test.ts`. Text needs 4.5:1, large text (18px or 14px bold) and UI parts (control edges, dots, rings, fills) need 3:1. The ratios are computed from the OKLCH values with WCAG 2.x relative luminance.

<!-- tokens:contrast:start -->

| Foreground       | Background     | Needs        | Dark         | Light        | Used for                                  |
| ---------------- | -------------- | ------------ | ------------ | ------------ | ----------------------------------------- |
| `fg`             | `canvas`       | 4.5:1 (text) | 16.26:1 pass | 15.64:1 pass | Body text                                 |
| `fg`             | `surface`      | 4.5:1 (text) | 14.60:1 pass | 17.07:1 pass | Body text                                 |
| `fg`             | `well`         | 4.5:1 (text) | 15.65:1 pass | 15.50:1 pass | Body text                                 |
| `fg`             | `hover`        | 4.5:1 (text) | 11.99:1 pass | 13.87:1 pass | Body text                                 |
| `fg`             | `raised`       | 4.5:1 (text) | 10.16:1 pass | 17.31:1 pass | Body text                                 |
| `fg-muted`       | `canvas`       | 4.5:1 (text) | 8.77:1 pass  | 7.02:1 pass  | Secondary text, placeholders              |
| `fg-muted`       | `surface`      | 4.5:1 (text) | 7.87:1 pass  | 7.66:1 pass  | Secondary text, placeholders              |
| `fg-muted`       | `well`         | 4.5:1 (text) | 8.44:1 pass  | 6.96:1 pass  | Secondary text, placeholders              |
| `fg-muted`       | `hover`        | 4.5:1 (text) | 6.46:1 pass  | 6.22:1 pass  | Secondary text, placeholders              |
| `fg-muted`       | `raised`       | 4.5:1 (text) | 5.48:1 pass  | 7.77:1 pass  | Secondary text, placeholders              |
| `fg`             | `code-bg`      | 4.5:1 (text) | 16.90:1 pass | 15.19:1 pass | Code and log text                         |
| `fg-muted`       | `code-bg`      | 4.5:1 (text) | 9.11:1 pass  | 6.81:1 pass  | Log timestamps                            |
| `fg`             | `diff-add`     | 4.5:1 (text) | 12.80:1 pass | 14.77:1 pass | Added line                                |
| `fg`             | `diff-del`     | 4.5:1 (text) | 13.31:1 pass | 14.45:1 pass | Removed line                              |
| `on-brand`       | `brand`        | 4.5:1 (text) | 7.61:1 pass  | 6.27:1 pass  | Primary button label                      |
| `on-brand`       | `brand-hover`  | 4.5:1 (text) | 9.09:1 pass  | 7.84:1 pass  | Primary button label, hover               |
| `on-danger`      | `danger`       | 4.5:1 (text) | 6.18:1 pass  | 7.19:1 pass  | Destructive button label                  |
| `on-danger`      | `danger-hover` | 4.5:1 (text) | 7.50:1 pass  | 8.75:1 pass  | Destructive button label, hover           |
| `brand-fg`       | `surface`      | 4.5:1 (text) | 10.16:1 pass | 7.92:1 pass  | brand text on surface                     |
| `brand-fg`       | `canvas`       | 4.5:1 (text) | 11.31:1 pass | 7.26:1 pass  | brand text on canvas                      |
| `brand-fg`       | `raised`       | 4.5:1 (text) | 7.07:1 pass  | 8.03:1 pass  | brand text on a floating layer            |
| `brand-fg`       | `brand-soft`   | 4.5:1 (text) | 7.77:1 pass  | 6.85:1 pass  | brand badge                               |
| `warn-fg`        | `surface`      | 4.5:1 (text) | 11.72:1 pass | 8.15:1 pass  | warn text on surface                      |
| `warn-fg`        | `canvas`       | 4.5:1 (text) | 13.05:1 pass | 7.47:1 pass  | warn text on canvas                       |
| `warn-fg`        | `raised`       | 4.5:1 (text) | 8.15:1 pass  | 8.27:1 pass  | warn text on a floating layer             |
| `warn-fg`        | `warn-soft`    | 4.5:1 (text) | 7.90:1 pass  | 7.11:1 pass  | warn badge                                |
| `danger-fg`      | `surface`      | 4.5:1 (text) | 9.98:1 pass  | 7.73:1 pass  | danger text on surface                    |
| `danger-fg`      | `canvas`       | 4.5:1 (text) | 11.11:1 pass | 7.08:1 pass  | danger text on canvas                     |
| `danger-fg`      | `raised`       | 4.5:1 (text) | 6.94:1 pass  | 7.84:1 pass  | danger text on a floating layer           |
| `danger-fg`      | `danger-soft`  | 4.5:1 (text) | 7.20:1 pass  | 6.60:1 pass  | danger badge                              |
| `info-fg`        | `surface`      | 4.5:1 (text) | 10.23:1 pass | 8.44:1 pass  | info text on surface                      |
| `info-fg`        | `canvas`       | 4.5:1 (text) | 11.39:1 pass | 7.74:1 pass  | info text on canvas                       |
| `info-fg`        | `raised`       | 4.5:1 (text) | 7.11:1 pass  | 8.56:1 pass  | info text on a floating layer             |
| `info-fg`        | `info-soft`    | 4.5:1 (text) | 7.41:1 pass  | 7.16:1 pass  | info badge                                |
| `neutral-fg`     | `surface`      | 4.5:1 (text) | 10.69:1 pass | 8.34:1 pass  | neutral text on surface                   |
| `neutral-fg`     | `canvas`       | 4.5:1 (text) | 11.90:1 pass | 7.64:1 pass  | neutral text on canvas                    |
| `neutral-fg`     | `raised`       | 4.5:1 (text) | 7.43:1 pass  | 8.46:1 pass  | neutral text on a floating layer          |
| `neutral-fg`     | `neutral-soft` | 4.5:1 (text) | 7.73:1 pass  | 6.89:1 pass  | neutral badge                             |
| `danger-fg`      | `surface`      | 3:1 (large)  | 9.98:1 pass  | 7.73:1 pass  | Danger zone heading                       |
| `control-edge`   | `surface`      | 3:1 (ui)     | 3.63:1 pass  | 3.89:1 pass  | Input, select, checkbox edge              |
| `brand`          | `surface`      | 3:1 (ui)     | 7.15:1 pass  | 6.35:1 pass  | Switch on, checkbox checked, primary fill |
| `brand-dot`      | `surface`      | 3:1 (ui)     | 7.77:1 pass  | 3.35:1 pass  | Success dot                               |
| `warn-dot`       | `surface`      | 3:1 (ui)     | 8.91:1 pass  | 3.54:1 pass  | Fallback and warning dot                  |
| `danger-dot`     | `surface`      | 3:1 (ui)     | 6.81:1 pass  | 4.67:1 pass  | Error dot                                 |
| `info-dot`       | `surface`      | 3:1 (ui)     | 7.83:1 pass  | 4.25:1 pass  | Info dot                                  |
| `neutral-dot`    | `surface`      | 3:1 (ui)     | 6.81:1 pass  | 4.78:1 pass  | Idle and unknown dot                      |
| `control-edge`   | `canvas`       | 3:1 (ui)     | 4.05:1 pass  | 3.57:1 pass  | Input, select, checkbox edge              |
| `brand`          | `canvas`       | 3:1 (ui)     | 7.96:1 pass  | 5.82:1 pass  | Switch on, checkbox checked, primary fill |
| `brand-dot`      | `canvas`       | 3:1 (ui)     | 8.66:1 pass  | 3.07:1 pass  | Success dot                               |
| `warn-dot`       | `canvas`       | 3:1 (ui)     | 9.93:1 pass  | 3.24:1 pass  | Fallback and warning dot                  |
| `danger-dot`     | `canvas`       | 3:1 (ui)     | 7.59:1 pass  | 4.28:1 pass  | Error dot                                 |
| `info-dot`       | `canvas`       | 3:1 (ui)     | 8.72:1 pass  | 3.90:1 pass  | Info dot                                  |
| `neutral-dot`    | `canvas`       | 3:1 (ui)     | 7.58:1 pass  | 4.38:1 pass  | Idle and unknown dot                      |
| `control-edge`   | `well`         | 3:1 (ui)     | 3.89:1 pass  | 3.53:1 pass  | Input, select, checkbox edge              |
| `brand`          | `well`         | 3:1 (ui)     | 7.67:1 pass  | 5.77:1 pass  | Switch on, checkbox checked, primary fill |
| `brand-dot`      | `well`         | 3:1 (ui)     | 8.33:1 pass  | 3.04:1 pass  | Success dot                               |
| `warn-dot`       | `well`         | 3:1 (ui)     | 9.56:1 pass  | 3.22:1 pass  | Fallback and warning dot                  |
| `danger-dot`     | `well`         | 3:1 (ui)     | 7.30:1 pass  | 4.24:1 pass  | Error dot                                 |
| `info-dot`       | `well`         | 3:1 (ui)     | 8.39:1 pass  | 3.86:1 pass  | Info dot                                  |
| `neutral-dot`    | `well`         | 3:1 (ui)     | 7.30:1 pass  | 4.35:1 pass  | Idle and unknown dot                      |
| `focus`          | `canvas`       | 3:1 (ui)     | 16.26:1 pass | 15.64:1 pass | Focus ring                                |
| `focus`          | `surface`      | 3:1 (ui)     | 14.60:1 pass | 17.07:1 pass | Focus ring                                |
| `focus`          | `well`         | 3:1 (ui)     | 15.65:1 pass | 15.50:1 pass | Focus ring                                |
| `focus`          | `hover`        | 3:1 (ui)     | 11.99:1 pass | 13.87:1 pass | Focus ring                                |
| `focus`          | `raised`       | 3:1 (ui)     | 10.16:1 pass | 17.31:1 pass | Focus ring                                |
| `focus`          | `code-bg`      | 3:1 (ui)     | 16.90:1 pass | 15.19:1 pass | Focus ring                                |
| `focus`          | `diff-add`     | 3:1 (ui)     | 12.80:1 pass | 14.77:1 pass | Focus ring                                |
| `focus`          | `diff-del`     | 3:1 (ui)     | 13.31:1 pass | 14.45:1 pass | Focus ring                                |
| `danger`         | `surface`      | 3:1 (ui)     | 5.50:1 pass  | 7.09:1 pass  | Destructive button fill                   |
| `chart-requests` | `surface`      | 3:1 (ui)     | 7.83:1 pass  | 4.82:1 pass  | Chart mark                                |
| `chart-errors`   | `surface`      | 3:1 (ui)     | 6.81:1 pass  | 4.67:1 pass  | Chart mark                                |
| `chart-deploy`   | `surface`      | 3:1 (ui)     | 10.01:1 pass | 9.08:1 pass  | Chart mark                                |
| `chart-2xx`      | `surface`      | 3:1 (ui)     | 8.37:1 pass  | 3.63:1 pass  | Chart mark                                |
| `chart-3xx`      | `surface`      | 3:1 (ui)     | 8.58:1 pass  | 3.81:1 pass  | Chart mark                                |
| `chart-4xx`      | `surface`      | 3:1 (ui)     | 8.93:1 pass  | 3.67:1 pass  | Chart mark                                |
| `chart-5xx`      | `surface`      | 3:1 (ui)     | 6.81:1 pass  | 4.67:1 pass  | Chart mark                                |
| `chart-other`    | `surface`      | 3:1 (ui)     | 6.81:1 pass  | 4.78:1 pass  | Chart mark                                |
| `chart-series`   | `surface`      | 3:1 (ui)     | 7.62:1 pass  | 5.02:1 pass  | Chart mark                                |
| `chart-requests` | `canvas`       | 3:1 (ui)     | 8.72:1 pass  | 4.42:1 pass  | Chart mark                                |
| `chart-errors`   | `canvas`       | 3:1 (ui)     | 7.59:1 pass  | 4.28:1 pass  | Chart mark                                |
| `chart-deploy`   | `canvas`       | 3:1 (ui)     | 11.14:1 pass | 8.32:1 pass  | Chart mark                                |
| `chart-2xx`      | `canvas`       | 3:1 (ui)     | 9.32:1 pass  | 3.33:1 pass  | Chart mark                                |
| `chart-3xx`      | `canvas`       | 3:1 (ui)     | 9.56:1 pass  | 3.49:1 pass  | Chart mark                                |
| `chart-4xx`      | `canvas`       | 3:1 (ui)     | 9.94:1 pass  | 3.36:1 pass  | Chart mark                                |
| `chart-5xx`      | `canvas`       | 3:1 (ui)     | 7.59:1 pass  | 4.28:1 pass  | Chart mark                                |
| `chart-other`    | `canvas`       | 3:1 (ui)     | 7.58:1 pass  | 4.38:1 pass  | Chart mark                                |
| `chart-series`   | `canvas`       | 3:1 (ui)     | 8.49:1 pass  | 4.60:1 pass  | Chart mark                                |
| `chart-requests` | `well`         | 3:1 (ui)     | 8.39:1 pass  | 4.38:1 pass  | Chart mark                                |
| `chart-errors`   | `well`         | 3:1 (ui)     | 7.30:1 pass  | 4.24:1 pass  | Chart mark                                |
| `chart-deploy`   | `well`         | 3:1 (ui)     | 10.73:1 pass | 8.25:1 pass  | Chart mark                                |
| `chart-2xx`      | `well`         | 3:1 (ui)     | 8.98:1 pass  | 3.30:1 pass  | Chart mark                                |
| `chart-3xx`      | `well`         | 3:1 (ui)     | 9.20:1 pass  | 3.46:1 pass  | Chart mark                                |
| `chart-4xx`      | `well`         | 3:1 (ui)     | 9.57:1 pass  | 3.33:1 pass  | Chart mark                                |
| `chart-5xx`      | `well`         | 3:1 (ui)     | 7.30:1 pass  | 4.24:1 pass  | Chart mark                                |
| `chart-other`    | `well`         | 3:1 (ui)     | 7.30:1 pass  | 4.35:1 pass  | Chart mark                                |
| `chart-series`   | `well`         | 3:1 (ui)     | 8.17:1 pass  | 4.56:1 pass  | Chart mark                                |

<!-- tokens:contrast:end -->

Hairlines are decorative dividers and are deliberately below 3:1. They never carry meaning on their own. Anything that identifies a control (input, select, checkbox, switch) uses `control-edge`, which clears 3:1.

<!-- tokens:decorative:start -->

| Hairline          | Against   | Dark   | Light  |
| ----------------- | --------- | ------ | ------ |
| `hairline`        | `canvas`  | 1.38:1 | 1.22:1 |
| `hairline`        | `surface` | 1.24:1 | 1.33:1 |
| `hairline-strong` | `surface` | 1.84:1 | 1.72:1 |
| `chart-grid`      | `surface` | 1.44:1 | 1.42:1 |

<!-- tokens:decorative:end -->

### Using status colors

| Meaning                 | Family          | Use for                                                                 | Never use for                                               |
| ----------------------- | --------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| Success, primary action | `brand` (green) | Primary button, ready or healthy state, success toast, checked controls | Decoration, links, selection, charts with no status meaning |
| Degraded but working    | `warn` (amber)  | "Fell back to supervisor", usage near its limit, deprecations           | Errors, anything that blocks the user                       |
| Failure needing action  | `danger`        | Failed deploy, validation errors, destructive buttons, the danger zone  | Fallback, warnings, emphasis                                |
| Neutral information     | `info` (blue)   | Notices, in-progress states                                             | Success or failure                                          |
| Idle, unknown, off      | `neutral-*`     | Stopped, no data, disabled                                              | Anything with a deadline                                    |

Rules:

- Pair every status with a label. `StatusDot` and `Badge` require visible text or an `aria-label`.
- Text on a status background uses the `*-fg` token on `*-soft`. Solid fills (`brand`, `danger`) take `on-brand` and `on-danger`.
- Chart colors follow HTTP classes: green 2xx (it is success), sky 3xx, amber 4xx, red 5xx, grey other. Requests are blue, errors red, a second series violet, and the deploy marker a neutral dashed rule. Requests are not green: green means success.
- Shapes: success is a circle, warning a triangle, danger a cross, info a ring (it spins while building) and neutral a square.
- One `brand` button per view. If two actions compete, one is `secondary`.

## Typography

Figtree for UI, JetBrains Mono (slashed zero) for ids, hashes, keys and logs. Headings use `text-wrap: balance`, prose `text-wrap: pretty`, and the root is antialiased. Numbers in tables and tiles use tabular figures (`tabular-nums`). Body copy never goes below 13px; 12px is for captions and keycaps only.

<!-- tokens:type:start -->

| Step     | Size / line | Weight | Tracking | Utility       | Use                             |
| -------- | ----------- | ------ | -------- | ------------- | ------------------------------- |
| `xs`     | 12px / 16px | 500    | 0em      | `text-xs`     | Captions, keycaps, dense meta   |
| `sm`     | 13px / 20px | 400    | 0em      | `text-sm`     | Labels, helper text, table meta |
| `base`   | 14px / 20px | 400    | 0em      | `text-base`   | Body, controls, table cells     |
| `md`     | 15px / 22px | 600    | -0.005em | `text-md`     | Section titles                  |
| `lg`     | 18px / 26px | 700    | -0.01em  | `text-lg`     | Dialog and panel titles         |
| `xl`     | 24px / 32px | 700    | -0.015em | `text-xl`     | Page titles on small screens    |
| `2xl`    | 28px / 36px | 700    | -0.02em  | `text-2xl`    | Page titles                     |
| `metric` | 36px / 40px | 700    | -0.025em | `text-metric` | KPI numbers (tabular figures)   |

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

Radii are concentric: outer = inner + padding. A button or input is 8. A menu or popover (12) holds 8px items with 4px padding. A tab list (10) holds 6px tabs with 4px padding. Cards, dialogs and toasts are 12. Surfaces use tone and shadow instead of borders; inputs draw their 3:1 edge as an inset ring (`shadow-field`).

<!-- tokens:radius:start -->

| Token  | Utility        | Size | Use                                              |
| ------ | -------------- | ---- | ------------------------------------------------ |
| `xs`   | `rounded-xs`   | 4px  | Keycaps, icon boxes inside a 8px control (8 - 4) |
| `sm`   | `rounded-sm`   | 6px  | Rows and segments inside a 10px well (10 - 4)    |
| `md`   | `rounded-md`   | 8px  | Buttons, inputs, selects, menu items, tabs       |
| `lg`   | `rounded-lg`   | 10px | Wells, tab lists, code blocks                    |
| `xl`   | `rounded-xl`   | 12px | Cards, popovers, menus, dialogs, toasts (8 + 4)  |
| `2xl`  | `rounded-2xl`  | 14px | Command palette (8 + 6)                          |
| `full` | `rounded-full` | pill | Badges, status pills, switch                     |

<!-- tokens:radius:end -->

<!-- tokens:border:start -->

| Token      | Width | Use                                                                 |
| ---------- | ----- | ------------------------------------------------------------------- |
| `hairline` | 1px   | Dividers and table rules only; surfaces separate by tone and shadow |
| `focus`    | 2px   | Focus ring (neutral ink)                                            |

<!-- tokens:border:end -->

## Shadow and elevation

Each shadow is a stack: a 1px ring, a contact shadow and an ambient shadow in light; a ring, a 1px top highlight and a deep ambient shadow in dark. `card` lifts a card, `button` and `primary` finish controls, `field` draws the control edge, `pill` is the sliding tab, `float` is for menus, selects, popovers and tooltips, `dialog` for dialogs and toasts. Floating layers also use the lighter `raised` surface, so in dark they read as clearly raised.

<!-- tokens:shadow:start -->

| Token         | Utility              | Dark                                                                                                                                    | Light                                                                                                                                                  |
| ------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `card`        | `shadow-card`        | `0 0 0 1px oklch(1 0 0 / 0.05), inset 0 1px 0 oklch(1 0 0 / 0.04)`                                                                      | `0 0 0 1px oklch(0.3 0 0 / 0.05), 0 1px 2px oklch(0.3 0 0 / 0.05)`                                                                                     |
| `button`      | `shadow-button`      | `inset 0 0 0 1px oklch(1 0 0 / 0.08)`                                                                                                   | `inset 0 0 0 1px oklch(0.3 0 0 / 0.07)`                                                                                                                |
| `primary`     | `shadow-primary`     | `inset 0 1px 0 oklch(1 0 0 / 0.25), 0 1px 2px oklch(0 0 0 / 0.4)`                                                                       | `inset 0 1px 0 oklch(1 0 0 / 0.18), 0 1px 2px oklch(0.3 0.08 150 / 0.3)`                                                                               |
| `field`       | `shadow-field`       | `inset 0 0 0 1px var(--sb-control-edge)`                                                                                                | `inset 0 0 0 1px var(--sb-control-edge)`                                                                                                               |
| `field-hover` | `shadow-field-hover` | `inset 0 0 0 1px var(--sb-fg-muted)`                                                                                                    | `inset 0 0 0 1px var(--sb-fg-muted)`                                                                                                                   |
| `pill`        | `shadow-pill`        | `0 0 0 1px oklch(1 0 0 / 0.1), inset 0 1px 0 oklch(1 0 0 / 0.08), 0 1px 3px oklch(0 0 0 / 0.4)`                                         | `0 0 0 1px oklch(0.3 0 0 / 0.06), 0 1px 2px oklch(0.3 0 0 / 0.1)`                                                                                      |
| `float`       | `shadow-float`       | `0 0 0 1px oklch(1 0 0 / 0.11), inset 0 1px 0 oklch(1 0 0 / 0.08), 0 2px 4px oklch(0 0 0 / 0.35), 0 18px 44px -6px oklch(0 0 0 / 0.65)` | `0 0 0 1px oklch(0.3 0 0 / 0.08), 0 1px 2px -1px oklch(0.3 0 0 / 0.12), 0 4px 8px -2px oklch(0.3 0 0 / 0.08), 0 16px 32px -8px oklch(0.3 0 0 / 0.18)`  |
| `dialog`      | `shadow-dialog`      | `0 0 0 1px oklch(1 0 0 / 0.11), inset 0 1px 0 oklch(1 0 0 / 0.08), 0 4px 8px oklch(0 0 0 / 0.35), 0 28px 72px -8px oklch(0 0 0 / 0.75)` | `0 0 0 1px oklch(0.3 0 0 / 0.08), 0 2px 4px -1px oklch(0.3 0 0 / 0.12), 0 8px 16px -4px oklch(0.3 0 0 / 0.1), 0 32px 64px -12px oklch(0.3 0 0 / 0.28)` |

<!-- tokens:shadow:end -->

## Motion

Rules (Krehel, Kowalski):

- **Curves.** `ease-out` (`cubic-bezier(.23,1,.32,1)`) for everything entering or pressed. `ease-in-out` (`cubic-bezier(.77,0,.175,1)`) only for an indicator that slides across the screen (the tab pill). Hover colour uses plain `ease`. No ease-in.
- **Durations.** Press 160ms. Tooltip 150 in, 100 out. Menu, select and popover 180 in, 120 out. Dialog 220 in, 150 out. Tab pill 250. Toast 360 in, 200 out.
- **Scale and origin.** Layers enter from scale 0.96 (never lower) with the origin at the trigger (`origin-(--transform-origin)`). Dialogs scale from their center. Buttons press to 0.97.
- **Tooltips are warm.** The provider waits 450ms, then neighbours open with no delay and no animation for 300ms.
- **Keyboard opens do not animate.** A menu, select, popover or dialog opened with a key press (or Enter on a trigger) sets `data-sb-instant` and skips the transition; ⌘K-style palettes do not animate at all.
- **Implementation.** CSS transitions with Base UI's `data-starting-style` and `data-ending-style` (its `@starting-style`), never keyframes, so every transition can be interrupted. Only `opacity`, `scale`, `translate` and colors move. Transitions name their properties, never `all`. Hover styles sit behind `(hover: hover)`.
- **Reduced motion.** `--sb-move` drops to 0, every `--sb-scale-*` becomes 1 and toasts fade in place; opacity and colour fades stay (durations are not zeroed). The tab pill and switch thumb jump, the spinner stops.

<!-- tokens:motion:start -->

| Token                       | Value                             | Reduced motion         |
| --------------------------- | --------------------------------- | ---------------------- |
| `--sb-duration-hover`       | 120ms                             | unchanged (fade stays) |
| `--sb-duration-press`       | 160ms                             | unchanged (fade stays) |
| `--sb-duration-tooltip-in`  | 150ms                             | unchanged (fade stays) |
| `--sb-duration-tooltip-out` | 100ms                             | unchanged (fade stays) |
| `--sb-duration-popup-in`    | 180ms                             | unchanged (fade stays) |
| `--sb-duration-popup-out`   | 120ms                             | unchanged (fade stays) |
| `--sb-duration-dialog-in`   | 220ms                             | unchanged (fade stays) |
| `--sb-duration-dialog-out`  | 150ms                             | unchanged (fade stays) |
| `--sb-duration-slide`       | 250ms                             | unchanged (fade stays) |
| `--sb-duration-toast-in`    | 360ms                             | unchanged (fade stays) |
| `--sb-duration-toast-out`   | 200ms                             | unchanged (fade stays) |
| `ease-out`                  | `cubic-bezier(0.23, 1, 0.32, 1)`  | unchanged              |
| `ease-in-out`               | `cubic-bezier(0.77, 0, 0.175, 1)` | unchanged              |
| `ease-hover`                | `ease`                            | unchanged              |
| `--sb-scale-popup`          | 0.96                              | 1 (no scale)           |
| `--sb-scale-dialog`         | 0.96                              | 1 (no scale)           |
| `--sb-scale-press`          | 0.97                              | 1 (no scale)           |
| `--sb-scale-icon`           | 0.25                              | 1 (no scale)           |

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

- Every focusable element shows a 2px ring in `focus`, offset 2px, on `:focus-visible` only. Mouse clicks do not draw a ring; keyboard and programmatic focus do.
- **The ring is neutral, never green.** `focus` is the primary text ink: near-black in light, near-white in dark. Green means go or success, so a destructive control must not look safe while focused. The 2px offset leaves a gap of page background, so the ring contrasts with the page, not with the control fill, and it reads on every button variant.- The ring is an outline, so it is not clipped by `overflow: hidden` on the control. Inside a clipped scroller (tab lists, menus) use a negative offset (`-outline-offset-2`).
- The ring is an outline, so it is not clipped by `overflow: hidden` on the control. Inside a clipped scroller (tab lists, menus) use a negative offset (`-outline-offset-2`).- Never remove an outline without replacing it. Never rely on color change of the background alone.
- Invalid fields keep the same ring and add a `danger` ring plus an error message wired through `aria-describedby`.
- The ring must clear 3:1 against every surface it sits on; the contrast table covers `canvas`, `surface`, `well`, `hover`, `raised`, `code-bg` and the diff tints. It does not sit on a control fill: the offset gap is page background.

## Component rules

- Every component takes `className` (merged with `tailwind-merge`, so callers win) and a `ref` (React 19 ref prop, no `forwardRef` wrapper).
- States are covered through Base UI data attributes (`data-open`, `data-checked`, `data-disabled`, `data-invalid`) and `aria-*`, not through extra props.
- Icon-only controls require `label`, which becomes `aria-label` and the tooltip text.
- Loading disables interaction with `aria-busy` and `data-loading`, but keeps the button's width so nothing shifts.
- Menus with a checkbox or radio item reserve one fixed 1.5rem gutter (`--sb-gutter`) for every item, so item text lines up whether or not a row shows a check. Never pad only the checked row.
- Charts live in `@sproutboat/ui/charts`: `TimeseriesChart` (with a dashed deploy marker) and `Sparkline` wrap TanStack Charts and read only the `chart-*` tokens, so they follow the theme with no rebuild.
- Positioned layers (Tooltip, Popover, Menu, Select) flip and shift inside the viewport and use `collisionPadding`.
- Dialogs trap focus, restore it on close, and close on Escape. Destructive dialogs focus the cancel action first.
- Copy follows the product voice: sentence case, verb first on buttons ("Create project", never "Submit"), errors say what to do next.

## Adding or changing a token

1. Edit `tokens/tokens.ts`. If it is a color used as text or UI, add or update its pair in `tokens/pairs.ts`.
2. Run `bun run --cwd packages/ui tokens`.
3. Run `bun test packages/ui/test`. The contrast and drift tests must pass.
