import { Field, Select, Spinner, cn } from "@sproutboat/ikada";
import type { ReactNode } from "react";

/**
 * A titled card for a project tab: heading, one muted line, an optional action on the
 * right and the content below. The heading id names the section for screen readers.
 */
export function Section({
  id,
  title,
  description,
  action,
  children,
  className,
}: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn("flex min-w-0 flex-col gap-4 rounded-xl bg-surface p-4 shadow-card sm:p-5", className)}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-title`} className="text-md font-semibold">
            {title}
          </h2>
          {description ? <p className="mt-0.5 text-base text-fg-muted">{description}</p> : null}
        </div>
        {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A loading line that holds the height of a short list, so the tab does not jump when data lands. */
export function LoadingLine({ label }: { label: string }) {
  return (
    <div className="flex min-h-24 items-center justify-center gap-2 text-base text-fg-muted" aria-live="polite">
      <Spinner decorative />
      {label}
    </div>
  );
}

/** A plain muted note in place of an empty list. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-base text-fg-muted [&_code]:text-fg">{children}</p>;
}

/** Full timestamp for a `title`, so a relative time ("3h ago") still says exactly when. */
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
export const fullTime = (value: string | number) => FULL.format(new Date(value));

/** One filter dropdown with its visible label; the value is never empty, so a null from the Select is ignored. */
export function FilterSelect({
  label,
  value,
  options,
  onValueChange,
  className,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onValueChange: (value: string) => void;
  className?: string;
}) {
  return (
    <Field label={label} className={cn("w-full sm:w-44", className)}>
      <Select
        value={value}
        options={options}
        onValueChange={(next) => {
          if (next) onValueChange(next);
        }}
      />
    </Field>
  );
}
