import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import type { Status } from "./status";
import { StatusGlyph } from "./status-glyph";

export interface StatusDotProps extends Omit<ComponentProps<"span">, "children"> {
  status: Status;
  /** Required: a dot is never the only signal. */
  label: string;
  /** Keeps the label for screen readers and hides it visually (dense tables). */
  hideLabel?: boolean;
  /** Pulses for in-progress states; the ring stops spinning when motion is reduced. */
  pulse?: boolean;
}

export function StatusDot({
  status,
  label,
  hideLabel = false,
  pulse = false,
  className,
  ref,
  ...props
}: StatusDotProps) {
  return (
    <span
      ref={ref}
      data-status={status}
      className={cn("inline-flex items-center gap-2 text-base text-fg", className)}
      {...props}
    >
      <StatusGlyph status={status} pulse={pulse} />
      <span className={hideLabel ? "sr-only" : undefined}>{label}</span>
    </span>
  );
}
