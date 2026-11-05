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

/**
 * Live: serving traffic right now. A bullseye (ring with a solid centre), so it differs from the
 * solid Ready circle and from the half-filled in-progress ring. Only applies to success.
 */
const liveClass =
  "rounded-full border-2 border-brand-dot bg-[radial-gradient(circle,var(--sb-brand-dot)_0_30%,transparent_35%)]";

export interface StatusGlyphProps extends Omit<ComponentProps<"span">, "children"> {
  status: Status;
  /** Success that is serving traffic ("Live"): a bullseye instead of the solid "Ready" circle. */
  live?: boolean;
  /** Pulses (a fade) while in progress; the building ring and its wedge spin when motion is allowed. */
  pulse?: boolean;
}

/** A 10px shape per status (circle, bullseye for live, triangle, cross, half ring, square). Decorative: always paired with a label. */
export function StatusGlyph({ status, live = false, pulse = false, className, ...props }: StatusGlyphProps) {
  const isLive = live && status === "success";
  return (
    <span
      aria-hidden="true"
      data-glyph={isLive ? "live" : status}
      className={cn(
        "inline-block size-2.5 shrink-0",
        status === "info" || isLive ? "" : dotColor[status],
        isLive ? liveClass : glyphClass[status],
        pulse && (status === "info" ? "motion-safe:animate-spin" : "animate-pulse"),
        className,
      )}
      {...props}
    />
  );
}
