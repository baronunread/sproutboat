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

/** Visible focus ring: 2px neutral (near-black or near-white) outline, keyboard focus only. */
export const focusRing =
  "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** Same ring, drawn inside the box, for controls clipped by a scroller. */
export const focusRingInset =
  "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus";

/**
 * Enter and exit for menus, selects and popovers. 180ms in and 120ms out, from
 * scale 0.96 with the origin at the trigger (Base UI sets --transform-origin).
 * Keyboard-opened layers carry data-sb-instant and skip the animation.
 */
export const popupMotion = [
  "origin-(--transform-origin) transition-[opacity,scale] duration-(--sb-duration-popup-out) ease-out",
  "data-open:duration-(--sb-duration-popup-in)",
  "data-starting-style:scale-(--sb-scale-popup) data-starting-style:opacity-0",
  "data-ending-style:scale-(--sb-scale-popup) data-ending-style:opacity-0",
  "data-instant:transition-none data-sb-instant:transition-none",
].join(" ");

/** Floating surface used by menus, selects and popovers: a lighter step with a layered shadow. */
export const floatingSurface = "rounded-xl bg-raised text-fg shadow-float outline-none";

/** Hover colour fades 120ms, press scales 160ms ease-out. Names every property, never "all". */
export const pressMotion = [
  "[transition:background-color_var(--sb-duration-hover)_var(--ease-hover),color_var(--sb-duration-hover)_var(--ease-hover),box-shadow_var(--sb-duration-hover)_var(--ease-hover),scale_var(--sb-duration-press)_var(--ease-out)]",
  "active:scale-(--sb-scale-press)",
].join(" ");

/**
 * Text field and select trigger: a well with the control edge drawn as an inset
 * ring (3:1), not a border. Invalid swaps the ring to danger.
 */
export const fieldSurface = [
  "rounded-md bg-well text-fg shadow-field",
  "transition-[box-shadow,background-color] duration-(--sb-duration-hover) ease-hover",
  "hover:shadow-field-hover focus-visible:bg-surface",
  "aria-invalid:bg-danger-soft aria-invalid:shadow-[inset_0_0_0_1.5px_var(--sb-danger-dot)]",
  "data-invalid:bg-danger-soft data-invalid:shadow-[inset_0_0_0_1.5px_var(--sb-danger-dot)]",
  "data-disabled:cursor-not-allowed data-disabled:opacity-55",
].join(" ");

/** Touch targets stay at 44px on coarse pointers whatever the density. */
export const coarseTarget = "pointer-coarse:min-h-11";

/** Props of a Base UI part with `className` narrowed to a string (no state callback). */
export type WithClass<T> = Omit<T, "className"> & { className?: string };
