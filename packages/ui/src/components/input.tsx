import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentProps } from "react";
import { cn, coarseTarget, fieldSurface, focusRing } from "../lib/cn";

export const inputStyles = cn(
  "h-(--sb-control-h) w-full min-w-0 px-3 text-base",
  fieldSurface,
  "placeholder:text-fg-muted pointer-coarse:text-[16px]",
  "read-only:bg-hover",
  focusRing,
  coarseTarget,
);

export interface InputProps extends Omit<ComponentProps<typeof BaseInput>, "className"> {
  className?: string;
  /** Marks the field invalid: danger ring and aria-invalid. Prefer the Field error. */
  invalid?: boolean;
  /** Monospace face for ids, keys and hashes. */
  mono?: boolean;
}

export function Input({ invalid, mono, className, ref, ...props }: InputProps) {
  return (
    <BaseInput
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(inputStyles, mono && "font-mono text-sm", className)}
      {...props}
    />
  );
}
