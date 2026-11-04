import type { ComponentProps } from "react";
import { tv } from "../lib/cn";
import type { VariantProps } from "tailwind-variants";

const skeletonStyles = tv({
  base: "block bg-raised motion-safe:animate-pulse",
  variants: {
    kind: {
      line: "h-3.5 w-full rounded-sm",
      block: "h-20 w-full rounded-lg",
      circle: "size-8 rounded-full",
    },
  },
  defaultVariants: { kind: "line" },
});

export interface SkeletonProps extends Omit<ComponentProps<"span">, "children">, VariantProps<typeof skeletonStyles> {}

/** Decorative placeholder. Give the loading region `aria-busy` and a status message instead. */
export function Skeleton({ kind, className, ref, ...props }: SkeletonProps) {
  return <span ref={ref} aria-hidden="true" className={skeletonStyles({ kind, className })} {...props} />;
}
