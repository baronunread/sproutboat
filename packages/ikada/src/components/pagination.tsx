import type { ComponentProps } from "react";
import { cn, coarseTarget, focusRing } from "../lib/cn";
import { ChevronLeftIcon, ChevronRightIcon } from "../lib/icons";

export interface PaginationProps extends Omit<ComponentProps<"nav">, "onChange"> {
  /** Current page, starting at 1. */
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  /** Previous and next plus "Page 3 of 12", no number buttons. Use it on narrow screens. */
  compact?: boolean;
  /** Pages shown either side of the current one. Default 1. */
  siblings?: number;
}

/** A run of hidden pages: before the current window or after it. */
export type PageGap = "gap-start" | "gap-end";

/** The page numbers to show: the first, the last, the current and its siblings, with gaps between. */
export function pageRange(page: number, pageCount: number, siblings = 1): (number | PageGap)[] {
  const first = Math.max(2, page - siblings);
  const last = Math.min(pageCount - 1, page + siblings);
  const out: (number | PageGap)[] = [1];
  if (first > 2) out.push("gap-start");
  for (let n = first; n <= last; n += 1) out.push(n);
  if (last < pageCount - 1) out.push("gap-end");
  if (pageCount > 1) out.push(pageCount);
  return out;
}

const cell = cn(
  "inline-grid h-8 min-w-8 place-items-center rounded-md px-2 text-sm font-semibold tabular-nums text-fg-muted",
  "transition-colors duration-(--sb-duration-hover) ease-hover hover:bg-hover hover:text-fg",
  "disabled:pointer-events-none disabled:opacity-50",
  coarseTarget,
  focusRing,
);

export function Pagination({
  page,
  pageCount,
  onPageChange,
  compact = false,
  siblings = 1,
  className,
  ref,
  ...props
}: PaginationProps) {
  const go = (next: number) => onPageChange(Math.min(Math.max(1, next), Math.max(1, pageCount)));
  return (
    <nav ref={ref} aria-label="Pagination" className={cn("flex items-center gap-1", className)} {...props}>
      <button
        type="button"
        aria-label="Previous page"
        disabled={page <= 1}
        onClick={() => go(page - 1)}
        className={cell}
      >
        <ChevronLeftIcon />
      </button>
      {compact ? (
        <span className="px-2 text-sm text-fg-muted tabular-nums" aria-live="polite">
          Page {page} of {pageCount}
        </span>
      ) : (
        <ul className="flex items-center gap-1">
          {pageRange(page, pageCount, siblings).map((entry) => (
            <li key={entry}>
              {entry === "gap-start" || entry === "gap-end" ? (
                <span aria-hidden="true" className="inline-grid h-8 min-w-6 place-items-center text-fg-muted">
                  ...
                </span>
              ) : (
                <button
                  type="button"
                  aria-label={`Page ${entry}`}
                  aria-current={entry === page ? "page" : undefined}
                  onClick={() => go(entry)}
                  className={cn(
                    cell,
                    "aria-[current=page]:bg-hover aria-[current=page]:text-fg aria-[current=page]:shadow-pill",
                  )}
                >
                  {entry}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        aria-label="Next page"
        disabled={page >= pageCount}
        onClick={() => go(page + 1)}
        className={cell}
      >
        <ChevronRightIcon />
      </button>
    </nav>
  );
}
