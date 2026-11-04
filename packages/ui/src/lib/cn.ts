import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import { createTV } from "tailwind-variants";
import { typeScale } from "../tokens.generated";

/** tailwind-merge that knows our `text-<step>` sizes are sizes, not colors. */
export const merge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: Object.keys(typeScale) }] } },
});

/** Join and de-conflict class names; later arguments win. */
export const cn = (...inputs: ClassValue[]): string => merge(clsx(inputs));

export const tv = createTV({ twMerge: merge });

/** Visible focus ring: 2px outline in the `focus` token, keyboard focus only. */
export const focusRing =
  "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** Same ring, drawn inside the box, for controls clipped by a scroller. */
export const focusRingInset =
  "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus";

/** Shared enter/exit transition for Base UI popups. */
export const popupMotion =
  "transition-[opacity,transform] duration-(--sb-duration-base) ease-standard data-starting-style:scale-[0.97] data-starting-style:opacity-0 data-ending-style:scale-[0.97] data-ending-style:opacity-0";

/** Floating surface used by menus, selects, popovers and tooltips. */
export const floatingSurface = "rounded-lg bg-surface text-fg shadow-popover outline-none";

/** Touch targets stay at 44px on coarse pointers whatever the density. */
export const coarseTarget = "pointer-coarse:min-h-11";

/** Props of a Base UI part with `className` narrowed to a string (no state callback). */
export type WithClass<T> = Omit<T, "className"> & { className?: string };
