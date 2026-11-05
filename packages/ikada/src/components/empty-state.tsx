import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";

export interface EmptyStateProps extends Omit<ComponentProps<"div">, "title"> {
  icon?: ReactNode;
  title: ReactNode;
  /** One line: what this list will hold or what to do next. */
  description?: ReactNode;
  /** One action. A second one means the empty state is saying too much. */
  action?: ReactNode;
  /** Heading level of the title. */
  as?: "h2" | "h3" | "h4";
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  as: Heading = "h3",
  className,
  ref,
  ...props
}: EmptyStateProps) {
  return (
    <div
      ref={ref}
      className={cn("mx-auto flex max-w-sm flex-col items-center gap-3 px-4 py-8 text-center", className)}
      {...props}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className="grid size-10 place-items-center rounded-lg bg-well text-fg-muted [&>svg]:size-5"
        >
          {icon}
        </span>
      ) : null}
      <div className="flex flex-col gap-1">
        <Heading className="text-md font-semibold">{title}</Heading>
        {description ? <p className="text-base text-fg-muted">{description}</p> : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
