import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentProps } from "react";
import { cn, coarseTarget, focusRing } from "../lib/cn";

export const inputStyles = cn(
  "h-(--sb-control-h) w-full min-w-0 rounded-lg border border-control-edge bg-surface px-3 text-base text-fg",
  "placeholder:text-fg-muted pointer-coarse:text-[16px]",
  "transition-[border-color,background-color] duration-(--sb-duration-fast) ease-standard",
  "hover:border-fg-muted",
  "data-disabled:cursor-not-allowed data-disabled:bg-raised data-disabled:opacity-55",
  "read-only:bg-raised",
  "data-invalid:border-danger-dot aria-invalid:border-danger-dot",
  focusRing,
  coarseTarget,
);

export interface InputProps extends Omit<ComponentProps<typeof BaseInput>, "className"> {
  className?: string;
  /** Marks the field invalid: red edge and aria-invalid. Prefer the Field error. */
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
