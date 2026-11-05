import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";

export interface DescriptionItem {
  /** Stable key. */
  id: string;
  term: ReactNode;
  details: ReactNode;
  /** Monospace face for ids, hostnames and hashes. */
  mono?: boolean;
}

export interface DescriptionListProps extends Omit<ComponentProps<"dl">, "children"> {
  items: readonly DescriptionItem[];
  /** `stacked` puts each term above its details; `inline` puts them side by side from 32rem up. */
  layout?: "stacked" | "inline";
}

/** Term and details pairs: an account, a deployment. Rules between rows, no boxes. */
export function DescriptionList({ items, layout = "inline", className, ref, ...props }: DescriptionListProps) {
  return (
    <dl ref={ref} className={cn("@container m-0 flex flex-col text-base", className)} {...props}>
      {items.map((item) => (
        <div
          key={item.id}
          className={cn(
            "grid gap-x-6 gap-y-0.5 border-b border-hairline py-3 first:pt-0 last:border-b-0 last:pb-0",
            layout === "inline" && "@md:grid-cols-[10rem_minmax(0,1fr)]",
          )}
        >
          <dt className="text-sm font-medium text-fg-muted">{item.term}</dt>
          <dd className={cn("m-0 min-w-0 break-words", item.mono && "font-mono text-sm")}>{item.details}</dd>
        </div>
      ))}
    </dl>
  );
}
