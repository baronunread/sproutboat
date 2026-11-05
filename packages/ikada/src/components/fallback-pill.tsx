import type { ComponentProps, ReactNode } from "react";
import { cn, focusRing } from "../lib/cn";
import { softSurface } from "./status";
import { StatusGlyph } from "./status-glyph";
import { Tooltip } from "./tooltip";

export interface FallbackPillProps extends Omit<ComponentProps<"button">, "children"> {
  /** Why it fell back, e.g. "abi_rejected: the build failed the ABI check". Shown in a tooltip. */
  reason?: ReactNode;
  children?: ReactNode;
  /** Opens the tooltip on mount (for docs and screenshots). */
  defaultOpen?: boolean;
  /** Short "Fell back" text for narrow cells; the accessible name stays "Fell back to supervisor". */
  compact?: boolean;
  /** When set the pill is a link to the details. */
  href?: string;
}

/**
 * "Fell back to supervisor". Amber, never red: the version is serving, only through the
 * fallback runtime. It is a button so the reason is reachable by keyboard and touch.
 */
export function FallbackPill({
  reason,
  compact = false,
  children = compact ? "Fell back" : "Fell back to supervisor",
  defaultOpen,
  href,
  className,
  ref,
  ...props
}: FallbackPillProps) {
  const classes = cn(
    "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-semibold",
    softSurface.warning,
    "transition-[filter] duration-(--sb-duration-hover) ease-hover hover:brightness-110",
    "before:absolute before:-inset-2 before:content-[''] relative pointer-fine:before:hidden",
    focusRing,
    className,
  );
  const label = compact ? { "aria-label": "Fell back to supervisor" } : {};
  const body = (
    <>
      <StatusGlyph status="warning" />
      {children}
    </>
  );
  const trigger = href ? (
    <a href={href} className={classes} {...label}>
      {body}
    </a>
  ) : (
    <button ref={ref} type="button" data-tone="warning" className={classes} {...label} {...props}>
      {body}
    </button>
  );
  return reason ? (
    <Tooltip content={reason} defaultOpen={defaultOpen}>
      {trigger}
    </Tooltip>
  ) : (
    trigger
  );
}
