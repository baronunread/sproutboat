import { cn } from "@sproutboat/ikada";
import type { ComponentProps, ReactNode } from "react";

export type LogTone = "default" | "ok" | "info" | "warn" | "danger";

const TONE = {
  default: "text-fg",
  ok: "text-brand-fg",
  info: "text-info-fg",
  warn: "text-warn-fg",
  danger: "text-danger-fg",
} satisfies Record<LogTone, string>;

/** The text color for an HTTP status: success green, redirect blue, everything from 400 up red. */
export const statusTone = (status: number): LogTone => (status >= 400 ? "danger" : status >= 300 ? "info" : "ok");

/**
 * One line of a monospace log: a fixed-width time, then free-form cells. Cells wrap on narrow
 * screens instead of pushing the list sideways. `failed` tints the whole row.
 */
export function LogRow({
  time,
  failed = false,
  className,
  children,
  ...props
}: { time: ReactNode; failed?: boolean } & ComponentProps<"li">) {
  return (
    <li
      className={cn(
        "flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3.5 py-1.5 font-mono text-sm leading-6",
        "shadow-[inset_0_1px_0_var(--sb-hairline)] first:shadow-none hover:bg-hover/60",
        failed && "bg-danger-soft/50",
        className,
      )}
      {...props}
    >
      {time}
      {children}
    </li>
  );
}

/** A cell of a `LogRow` with a tone and an optional fixed width. */
export function LogCell({ tone = "default", className, ...props }: { tone?: LogTone } & ComponentProps<"span">) {
  return <span className={cn(TONE[tone], className)} {...props} />;
}
