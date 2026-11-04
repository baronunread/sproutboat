import type { ComponentProps } from "react";
import { cn, focusRing } from "../lib/cn";
import { ArrowUpRightIcon } from "../lib/icons";

export interface LinkProps extends ComponentProps<"a"> {
  /** Opens in a new tab with a safe rel, shows an arrow and announces it. */
  external?: boolean;
}

export function Link({ external = false, className, children, ref, ...props }: LinkProps) {
  return (
    <a
      ref={ref}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={cn(
        "inline-flex items-center gap-1 rounded-sm font-medium text-fg underline decoration-hairline-strong underline-offset-4 transition-colors duration-(--sb-duration-fast) ease-standard",
        "hover:decoration-fg aria-disabled:pointer-events-none aria-disabled:opacity-55",
        focusRing,
        className,
      )}
      {...props}
    >
      {children}
      {external ? (
        <>
          <ArrowUpRightIcon className="size-3.5" />
          <span className="sr-only">(opens in a new tab)</span>
        </>
      ) : null}
    </a>
  );
}
