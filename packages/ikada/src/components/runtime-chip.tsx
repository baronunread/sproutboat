import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import { softSurface } from "./status";
import type { Status } from "./status";
import { StatusGlyph } from "./status-glyph";

export type Runtime = "sproutd" | "supervisor" | "unknown";

const tone = { sproutd: "neutral", supervisor: "warning", unknown: "neutral" } satisfies Record<Runtime, Status>;

export interface RuntimeChipProps extends Omit<ComponentProps<"span">, "children"> {
  runtime: Runtime;
}

/**
 * Which runtime serves a version. sproutd is the normal path and stays neutral;
 * supervisor is the fallback and is amber (working, only differently). The name is
 * the signal and the glyph repeats it as a shape.
 */
export function RuntimeChip({ runtime, className, ref, ...props }: RuntimeChipProps) {
  return (
    <span
      ref={ref}
      data-runtime={runtime}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 font-mono text-xs font-medium",
        softSurface[tone[runtime]],
        className,
      )}
      {...props}
    >
      <StatusGlyph
        status={runtime === "supervisor" ? "warning" : "neutral"}
        className={runtime === "unknown" ? "opacity-50" : undefined}
      />
      {runtime === "unknown" ? "unknown" : runtime}
    </span>
  );
}
