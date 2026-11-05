# @sproutboat/ikada

The Sproutboat design system: design tokens and React components built on [Base UI](https://base-ui.com) and Tailwind CSS v4. It is what the Sproutboat dashboard is made of.

```sh
bun add @sproutboat/ikada
# peers: react, react-dom, tailwindcss
```

```css
/* your app.css */
@import "tailwindcss";
@import "@sproutboat/ikada/theme.css";
```

```tsx
import { Button } from "@sproutboat/ikada";
import { Sparkline } from "@sproutboat/ikada/charts";
import { colors, typeScale } from "@sproutboat/ikada/tokens";
```

| Export                        | Contents                                        |
| ----------------------------- | ----------------------------------------------- |
| `@sproutboat/ikada`           | Components, hooks and formatting helpers        |
| `@sproutboat/ikada/theme.css` | Tailwind v4 theme: colour, type, radius, motion |
| `@sproutboat/ikada/tokens`    | The same tokens as a typed TypeScript object    |
| `@sproutboat/ikada/charts`    | `Sparkline` and `TimeseriesChart`               |

The package ships TypeScript source, not a compiled build: use it from a bundler that compiles TypeScript in `node_modules` (Vite, Bun, or Next.js with `transpilePackages`).

See [DESIGN.md](DESIGN.md) for the principles and [INVENTORY.md](INVENTORY.md) for every component and its status.

MIT licensed.
