import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/** A keycap for shortcut hints. Decorative text: the control it sits in carries `aria-keyshortcuts`. */
export function Kbd({ className, ref, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      ref={ref}
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-xs bg-well px-1.5 font-mono text-xs font-medium text-fg-muted shadow-button",
        className,
      )}
      {...props}
    />
  );
}
