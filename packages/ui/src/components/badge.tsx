import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import { softSurface } from "./status";
import type { Status } from "./status";
import { StatusGlyph } from "./status-glyph";

export interface BadgeProps extends ComponentProps<"span"> {
  tone?: Status;
  /** Adds a leading status shape. The text is always the primary signal. */
  dot?: boolean;
}

export function Badge({ tone = "neutral", dot = false, className, children, ref, ...props }: BadgeProps) {
  return (
    <span
      ref={ref}
      data-tone={tone}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-semibold",
        dot && "ps-2",
        softSurface[tone],
        className,
      )}
      {...props}
    >
      {dot ? <StatusGlyph status={tone} /> : null}
      {children}
    </span>
  );
}
