import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { formatCompact } from "../lib/format";
import { useLocale } from "../lib/locale";
import { ArrowDownIcon, ArrowUpIcon } from "../lib/icons";
import { Skeleton } from "./skeleton";

export interface MetricDelta {
  /** "12%" or "0.3 pt". */
  value: string;
  direction: "up" | "down";
  /** Whether that direction is good news. Default neutral: a rise in requests is not good or bad. */
  sentiment?: "good" | "bad" | "neutral";
}

export interface MetricTileProps extends Omit<ComponentProps<"div">, "children"> {
  label: string;
  /** Already formatted: "0.21". For a plain count prefer `amount`. */
  value?: string;
  /** A count, formatted compactly in `locale` ("1.28M", "860K"). Wins over `value`. */
  amount?: number;
  /** Number-formatting locale; defaults to the `LocaleProvider` value, else `en`. */
  locale?: string;
  /** "M", "%", "ms p50". */
  unit?: string;
  delta?: MetricDelta;
  /** A line under the value: "14.8 req/s average". */
  hint?: ReactNode;
  /** A `<Sparkline />` from `@sproutboat/ikada/charts`, flush to the tile's bottom edge. */
  sparkline?: ReactNode;
  loading?: boolean;
  /** Nothing to show for this range: an em dash and `emptyText`. */
  noData?: boolean;
  emptyText?: string;
}

const sentimentClass = {
  good: "text-brand-fg",
  bad: "text-danger-fg",
  neutral: "text-fg-muted",
} as const;

/** One headline number with its unit, change and trend. */
export function MetricTile({
  label,
  value,
  amount,
  unit,
  delta,
  hint,
  sparkline,
  loading = false,
  noData = false,
  emptyText = "No data for this range",
  locale,
  className,
  ref,
  ...props
}: MetricTileProps) {
  const resolved = useLocale(locale);
  const shown = amount === undefined ? value : formatCompact(amount, { locale: resolved });
  const Arrow = delta?.direction === "up" ? ArrowUpIcon : ArrowDownIcon;
  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      aria-busy={loading || undefined}
      className={cn("flex min-w-0 flex-col overflow-hidden rounded-xl bg-surface shadow-card", className)}
      {...props}
    >
      <div className="flex flex-col gap-1 px-4 pt-3.5">
        <span className="text-sm font-medium text-fg-muted">{label}</span>
        {loading ? (
          <div className="flex flex-col gap-2 py-1.5">
            <Skeleton className="h-7 w-24" />
            <Skeleton className="w-32" />
            <span className="sr-only">Loading</span>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-1.5">
              <span className={cn("text-metric tabular-nums", noData && "text-fg-muted")}>{noData ? "—" : shown}</span>
              {unit && !noData ? <span className="text-base font-medium text-fg-muted">{unit}</span> : null}
              {delta && !noData ? (
                <span
                  className={cn(
                    "ms-1 inline-flex items-center gap-0.5 text-sm font-semibold tabular-nums",
                    sentimentClass[delta.sentiment ?? "neutral"],
                  )}
                >
                  <Arrow className="size-3.5" />
                  <span className="sr-only">{delta.direction === "up" ? "Up" : "Down"} </span>
                  {delta.value}
                </span>
              ) : null}
            </div>
            <span className="min-h-5 text-sm text-fg-muted">{noData ? emptyText : hint}</span>
          </>
        )}
      </div>
      <div className="mt-2 h-10">{loading || noData ? null : sparkline}</div>
    </div>
  );
}
