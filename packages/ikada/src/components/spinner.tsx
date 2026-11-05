import type { ComponentProps } from "react";
import type { VariantProps } from "tailwind-variants";
import { SpinnerIcon } from "../lib/icons";
import { tv } from "../lib/cn";

const spinnerStyles = tv({
  base: "inline-flex shrink-0 items-center justify-center text-fg-muted",
  variants: { size: { sm: "[&>svg]:size-3.5", md: "[&>svg]:size-4", lg: "[&>svg]:size-6" } },
  defaultVariants: { size: "md" },
});

export interface SpinnerProps extends Omit<ComponentProps<"span">, "children">, VariantProps<typeof spinnerStyles> {
  /** What is loading. Announced politely; pass `decorative` when the parent already says it. */
  label?: string;
  /** Hide from assistive tech (the button or region it sits in is already `aria-busy`). */
  decorative?: boolean;
}

/**
 * A turning ring. Under reduced motion it stops turning and pulses (a fade) so it still
 * reads as "working", and the label carries the meaning either way.
 */
export function Spinner({ size, label = "Loading", decorative = false, className, ref, ...props }: SpinnerProps) {
  return (
    <span
      ref={ref}
      role={decorative ? undefined : "status"}
      aria-hidden={decorative || undefined}
      className={spinnerStyles({ size, className })}
      {...props}
    >
      <SpinnerIcon className="motion-reduce:animate-pulse" />
      {decorative ? null : <span className="sr-only">{label}</span>}
    </span>
  );
}
