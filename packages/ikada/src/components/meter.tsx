import { Meter as BaseMeter } from "@base-ui/react/meter";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { StatusGlyph } from "./status-glyph";
import type { Status } from "./status";

export type MeterTone = "normal" | "warning" | "danger";

const fill = {
  normal: "bg-fg",
  warning: "bg-warn-dot",
  danger: "bg-danger-dot",
} satisfies Record<MeterTone, string>;

export interface MeterProps extends Omit<ComponentProps<typeof BaseMeter.Root>, "className" | "children"> {
  className?: string;
  /** Visible label above the bar. Without one, pass `aria-label`. */
  label?: ReactNode;
  tone?: MeterTone;
  /** Right of the label; defaults to the formatted value. */
  valueLabel?: ReactNode;
}

/** A bar for a bounded measurement. The fill grows over 250ms ease-out (a width change, so it also stays under reduced motion). */
export function Meter({ label, tone = "normal", valueLabel, className, ...props }: MeterProps) {
  return (
    <BaseMeter.Root className={cn("flex flex-col gap-1.5", className)} {...props}>
      {label || valueLabel !== null ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-base">
          {label ? <BaseMeter.Label className="font-medium">{label}</BaseMeter.Label> : <span />}
          {valueLabel === undefined ? <BaseMeter.Value className="tabular-nums text-fg-muted" /> : valueLabel}
        </div>
      ) : null}
      <BaseMeter.Track className="h-2 w-full overflow-hidden rounded-full shadow-[inset_0_0_0_1px_var(--sb-hairline-strong)]">
        <BaseMeter.Indicator
          data-tone={tone}
          className={cn(
            "h-full rounded-full transition-[width] duration-(--sb-duration-slide) ease-out motion-reduce:transition-none",
            fill[tone],
          )}
        />
      </BaseMeter.Track>
    </BaseMeter.Root>
  );
}

export interface UsageMeterProps extends Omit<MeterProps, "value" | "max" | "min" | "tone" | "valueLabel" | "format"> {
  used: number;
  /** `null` is unlimited: the bar is replaced by the number alone. */
  limit: number | null;
  /** Unit suffix, e.g. "GB" or "requests". */
  unit?: string;
  /** Near-limit threshold as a fraction. Default 0.8. */
  warnAt?: number;
  /**
   * The platform is actually refusing work (writes rejected, deploys paused). Only then
   * is the meter red. Reaching the limit without being blocked stays amber.
   */
  blocked?: boolean;
  formatValue?: (n: number) => string;
}

type UsageState = "under" | "near" | "at" | "blocked" | "unlimited";

export function usageState(used: number, limit: number | null, warnAt = 0.8, blocked = false): UsageState {
  if (limit === null) return "unlimited";
  if (blocked) return "blocked";
  if (used >= limit) return "at";
  return used >= limit * warnAt ? "near" : "under";
}

const stateText = {
  under: null,
  near: "Near limit",
  at: "At limit",
  blocked: "Blocked",
  unlimited: null,
} satisfies Record<UsageState, string | null>;

function stateStatus(state: UsageState): Status | undefined {
  if (state === "near" || state === "at") return "warning";
  return state === "blocked" ? "danger" : undefined;
}

/**
 * Usage against a plan limit. Amber from 80% and at 100%; red only when `blocked`. The
 * state is also written out (never color alone) and read by screen readers.
 */
export function UsageMeter({
  used,
  limit,
  unit,
  warnAt = 0.8,
  blocked = false,
  formatValue = (n) => n.toLocaleString(),
  label,
  className,
  ...props
}: UsageMeterProps) {
  const state = usageState(used, limit, warnAt, blocked);
  const suffix = unit ? ` ${unit}` : "";
  const text =
    limit === null
      ? `${formatValue(used)}${suffix}, unlimited`
      : `${formatValue(used)} of ${formatValue(limit)}${suffix}`;
  const stateLabel = stateText[state];
  const status = stateStatus(state);

  if (limit === null) {
    return (
      <div className={cn("flex items-baseline justify-between gap-3 text-base", className)}>
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-fg-muted">{text}</span>
      </div>
    );
  }

  return (
    <Meter
      label={label}
      value={Math.min(used, limit)}
      max={limit}
      tone={state === "blocked" ? "danger" : status ? "warning" : "normal"}
      getAriaValueText={() => `${text}${stateLabel ? `, ${stateLabel.toLowerCase()}` : ""}`}
      valueLabel={
        <span className="inline-flex items-center gap-2 whitespace-nowrap tabular-nums text-fg-muted">
          {stateLabel && status ? (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 font-semibold",
                status === "danger" ? "text-danger-fg" : "text-warn-fg",
              )}
            >
              <StatusGlyph status={status} />
              {stateLabel}
            </span>
          ) : null}
          {text}
        </span>
      }
      className={className}
      {...props}
    />
  );
}
