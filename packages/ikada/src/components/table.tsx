import type { ComponentProps, ReactNode } from "react";
import { cn, focusRing, focusRingInset } from "../lib/cn";
import { AlertIcon, ArrowDownIcon, ArrowUpIcon, SortIcon } from "../lib/icons";
import { Skeleton } from "./skeleton";

export type SortDirection = "asc" | "desc";

/** Cycles none, ascending, descending, none. */
export function nextSort(current: SortDirection | undefined): SortDirection | undefined {
  return current === undefined ? "asc" : current === "asc" ? "desc" : undefined;
}

/**
 * Container-query breakpoints for `hideBelow`. They measure the table's own scroll
 * container, not the viewport: sm 24rem, md 28rem, lg 32rem, xl 36rem, 2xl 42rem, 3xl 48rem, 4xl 56rem.
 * Full class names so Tailwind can see them.
 */
export type TableBreakpoint = "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl";

const hideBelowClass = {
  sm: "@max-sm:hidden",
  md: "@max-md:hidden",
  lg: "@max-lg:hidden",
  xl: "@max-xl:hidden",
  "2xl": "@max-2xl:hidden",
  "3xl": "@max-3xl:hidden",
  "4xl": "@max-4xl:hidden",
} satisfies Record<TableBreakpoint, string>;

export interface HideBelowProps {
  /**
   * Drops this column (set it on its `TableHead` and every `TableCell`) when the table's
   * container is narrower than the breakpoint. Use it for low-priority columns only; never put critical
   * status (failure) in a column that can hide; the
   * container still scrolls sideways as the last resort.
   */
  hideBelow?: TableBreakpoint;
}

export interface TableProps extends ComponentProps<"table"> {
  /** Names the scrolling region for screen readers. Required: say what the table lists. */
  label: string;
  /** Header stays put while the body scrolls. Pair with `maxHeight`. */
  stickyHeader?: boolean;
  /** CSS max-height of the scroll area, e.g. "24rem". */
  maxHeight?: string;
  /** Applied to the scroll container. */
  containerClassName?: string;
}

/**
 * A semantic table in a scroll container. Wide tables scroll inside it, never the page;
 * the container is focusable so a keyboard can scroll it. 48px rows (36px compact) are
 * set by `--sb-row-h`.
 */
export function Table({
  label,
  stickyHeader = false,
  maxHeight,
  containerClassName,
  className,
  children,
  ref,
  ...props
}: TableProps) {
  return (
    <div
      role="region"
      aria-label={label}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scroll region must be keyboard-focusable
      tabIndex={0}
      data-sticky={stickyHeader || undefined}
      style={maxHeight ? { maxHeight } : undefined}
      className={cn(
        "@container min-w-0 max-w-full overflow-auto overscroll-x-contain rounded-xl bg-surface shadow-card",
        focusRingInset,
        containerClassName,
      )}
    >
      <table
        ref={ref}
        className={cn("w-full border-separate border-spacing-0 text-start text-base", className)}
        {...props}
      >
        {children}
      </table>
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return (
    <thead
      className={cn(
        "[[data-sticky]_&_th]:sticky [[data-sticky]_&_th]:top-0 [[data-sticky]_&_th]:z-(--sb-z-sticky)",
        className,
      )}
      {...props}
    />
  );
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={className} {...props} />;
}

export interface TableRowProps extends ComponentProps<"tr"> {
  /** Highlights the row and sets aria-selected. Pair with a checkbox cell: that is the control. */
  selected?: boolean;
}

export function TableRow({ selected = false, className, ...props }: TableRowProps) {
  return (
    <tr
      aria-selected={selected || undefined}
      data-selected={selected || undefined}
      className={cn(
        "group/row transition-colors duration-(--sb-duration-hover) ease-hover hover:bg-hover/60",
        "data-selected:bg-hover data-selected:hover:bg-hover",
        className,
      )}
      {...props}
    />
  );
}

const cellBase = "px-4 text-start align-middle";

export interface TableHeadProps extends Omit<ComponentProps<"th">, "onClick" | "aria-sort">, HideBelowProps {
  /** Makes the header a button. `undefined` means sortable but not sorted. */
  sortable?: boolean;
  sort?: SortDirection;
  onSort?: () => void;
}

/** A column header. Sortable ones hold a button (Enter or Space) and set `aria-sort`. */
export function TableHead({
  sortable = false,
  sort,
  onSort,
  hideBelow,
  className,
  children,
  ...props
}: TableHeadProps) {
  const ariaSort = sortable ? (sort === "asc" ? "ascending" : sort === "desc" ? "descending" : "none") : undefined;
  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={cn(
        cellBase,
        "h-10 whitespace-nowrap bg-surface text-sm font-semibold text-fg-muted shadow-[inset_0_-1px_0_var(--sb-hairline)]",
        hideBelow && hideBelowClass[hideBelow],
        className,
      )}
      {...props}
    >
      {sortable ? (
        <button
          type="button"
          onClick={onSort}
          className={cn(
            "-mx-2 inline-flex h-8 items-center gap-1.5 rounded-md px-2 font-semibold transition-colors duration-(--sb-duration-hover) ease-hover hover:bg-hover hover:text-fg pointer-coarse:min-h-11",
            sort && "text-fg",
            focusRing,
          )}
        >
          {children}
          {sort === "asc" ? (
            <ArrowUpIcon className="size-3.5" />
          ) : sort === "desc" ? (
            <ArrowDownIcon className="size-3.5" />
          ) : (
            <SortIcon className="size-3.5 opacity-60" />
          )}
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function TableCell({ hideBelow, className, ...props }: ComponentProps<"td"> & HideBelowProps) {
  return (
    <td
      className={cn(
        cellBase,
        "h-(--sb-row-h) shadow-[inset_0_-1px_0_var(--sb-hairline)] group-last/row:shadow-none",
        hideBelow && hideBelowClass[hideBelow],
        className,
      )}
      {...props}
    />
  );
}

/** One cell spanning every column, for the empty, loading and error bodies. */
function StateRow({ colSpan, className, children }: { colSpan: number; className?: string; children: ReactNode }) {
  return (
    <TableRow className="hover:bg-transparent">
      <td colSpan={colSpan} className={cn("px-4 py-10 text-center", className)}>
        {children}
      </td>
    </TableRow>
  );
}

export function TableEmpty({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return <StateRow colSpan={colSpan}>{children}</StateRow>;
}

export function TableError({
  colSpan,
  title = "Could not load this list",
  children,
  action,
}: {
  colSpan: number;
  title?: string;
  children?: ReactNode;
  /** A retry Button. */
  action?: ReactNode;
}) {
  return (
    <StateRow colSpan={colSpan}>
      <div role="alert" className="mx-auto flex max-w-sm flex-col items-center gap-2">
        <AlertIcon className="size-5 text-danger-fg" />
        <p className="font-semibold">{title}</p>
        {children ? <p className="text-fg-muted">{children}</p> : null}
        {action ? <div className="mt-1">{action}</div> : null}
      </div>
    </StateRow>
  );
}

/** Skeleton rows that keep the layout of the loaded table. Set `aria-busy` on the Table while loading. */
export function TableLoading({ columns, rows = 4 }: { columns: number; rows?: number }) {
  return Array.from({ length: rows }, (_, r) => (
    <TableRow key={r} className="hover:bg-transparent" aria-hidden="true">
      {Array.from({ length: columns }, (_, c) => (
        <TableCell key={c}>
          <Skeleton className={c === 0 ? "w-24" : c % 2 ? "w-3/4" : "w-1/2"} />
        </TableCell>
      ))}
    </TableRow>
  ));
}
