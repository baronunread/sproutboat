import { Banner, Button, Skeleton } from "@sproutboat/ikada";
import type { ReactNode } from "react";

/** The loading and failure states every list page shares, so a page body reads as its ready state only. */
export function LoadError({ what, onRetry }: { what: string; onRetry?: () => void }) {
  return (
    <Banner
      tone="danger"
      action={
        onRetry ? (
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    >
      Could not load {what}. Refresh and try again.
    </Banner>
  );
}

export function LoadingBlock({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-3 rounded-xl bg-surface p-5 shadow-card">
      <span className="sr-only">Loading {label}…</span>
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-5 w-full" />
      <Skeleton className="h-5 w-3/4" />
    </div>
  );
}

/** A card with a heading, for settings sections. */
export function Section({
  title,
  description,
  action,
  danger = false,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  danger?: boolean;
  children?: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-4 rounded-xl bg-surface p-5 shadow-card sm:p-6"
      data-danger={danger || undefined}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className={danger ? "text-lg font-bold text-danger-fg" : "text-lg font-bold"}>{title}</h2>
          {description ? <p className="mt-1 max-w-prose text-base text-fg-muted">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
