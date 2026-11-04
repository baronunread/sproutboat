import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

export const labelStyles = "inline-flex items-center gap-1 text-sm font-medium text-fg";

export interface LabelProps extends ComponentProps<"label"> {
  /** Shows a required marker. The control still needs `required` itself. */
  required?: boolean;
}

export function Label({ required, className, children, ref, ...props }: LabelProps) {
  return (
    <label ref={ref} className={cn(labelStyles, className)} {...props}>
      {children}
      {required ? (
        <span aria-hidden="true" className="text-fg-muted">
          *
        </span>
      ) : null}
    </label>
  );
}
