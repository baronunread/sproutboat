import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import { dotColor } from "./status";
import type { Status } from "./status";

const glyphClass = {
  success: "rounded-full",
  warning: "[clip-path:polygon(50%_0,100%_100%,0_100%)] -translate-y-px",
  danger:
    "[clip-path:polygon(20%_0,50%_30%,80%_0,100%_20%,70%_50%,100%_80%,80%_100%,50%_70%,20%_100%,0_80%,30%_50%,0_20%)]",
  // In progress: a ring with a filled half, like a pie at 50%. A closed ring plus a
  // wedge cannot be mistaken for the letter C, and it still differs from the solid circle.
  info: "rounded-full border-2 border-info-dot bg-[conic-gradient(var(--sb-info-dot)_0_50%,transparent_0)]",
  neutral: "rounded-xs scale-80",
} satisfies Record<Status, string>;

export interface StatusGlyphProps extends Omit<ComponentProps<"span">, "children"> {
  status: Status;
  /** Pulses (a fade) while in progress; the building ring and its wedge spin when motion is allowed. */
  pulse?: boolean;
}

/** A 10px shape per status (circle, triangle, cross, ring, square). Decorative: always paired with a label. */
export function StatusGlyph({ status, pulse = false, className, ...props }: StatusGlyphProps) {
  return (
    <span
      aria-hidden="true"
      data-glyph={status}
      className={cn(
        "inline-block size-2.5 shrink-0",
        status === "info" ? "" : dotColor[status],
        glyphClass[status],
        pulse && (status === "info" ? "motion-safe:animate-spin" : "animate-pulse"),
        className,
      )}
      {...props}
    />
  );
}
