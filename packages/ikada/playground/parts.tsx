import { useId } from "react";
import type { ReactNode } from "react";

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="flex flex-col gap-3" aria-labelledby={id}>
      <div className="flex flex-col gap-0.5">
        <h2 id={id} data-section={title} className="scroll-mt-16 text-md font-semibold">
          {title}
        </h2>
        {hint ? <p className="text-sm text-fg-muted">{hint}</p> : null}
      </div>
      <div className="flex flex-col gap-5 rounded-xl bg-surface p-4 shadow-card sm:p-5">{children}</div>
    </section>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-xs font-semibold text-fg-muted">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

/** ?open=menu|select|dialog|tooltip|popover|toast|palette|fallback|drawer|table-sorted opens that state for screenshots. */
export const openState = new URLSearchParams(location.search).get("open");
