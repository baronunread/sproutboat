import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import { dotColor, softSurface } from "./status";
import type { Status } from "./status";

export interface BadgeProps extends ComponentProps<"span"> {
  tone?: Status;
  /** Adds a leading status dot. The text is always the primary signal. */
  dot?: boolean;
}

export function Badge({ tone = "neutral", dot = false, className, children, ref, ...props }: BadgeProps) {
  return (
    <span
      ref={ref}
      data-tone={tone}
      className={cn(
        "inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-xs font-medium",
        softSurface[tone],
        className,
      )}
      {...props}
    >
      {dot ? <span aria-hidden="true" className={cn("size-1.5 rounded-full", dotColor[tone])} /> : null}
      {children}
    </span>
  );
}
