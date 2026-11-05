import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { CheckIcon } from "../lib/icons";

/** Confirmation state with a timer: `confirm()` turns `active` on, and it turns itself off after `duration` ms. */
export function useInlineConfirm(duration = 1600) {
  const [active, setActive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const confirm = useCallback(() => {
    setActive(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setActive(false), duration);
  }, [duration]);
  return { active, confirm };
}

export interface InlineConfirmProps extends Omit<ComponentProps<"span">, "children"> {
  /** The word shown and announced: "Copied", "Saved". */
  message: string;
  /** Screen-reader text when it differs from the visible word, e.g. "Copied to clipboard". */
  announce?: string;
  /** The control. It receives `confirm`; call it when the action succeeded. */
  children: (api: { confirm: () => void; active: boolean }) => ReactNode;
  /** `bubble` floats above the control and never moves the layout; `inline` sits beside it in a reserved slot. */
  appearance?: "bubble" | "inline";
  /** Milliseconds the confirmation stays. Default 1600. */
  duration?: number;
}

/**
 * Feedback next to the control that was used, not in the corner: Copied, Saved. It is a small primitive,
 * not a toast, so nothing is added to the notification history. A polite live region announces the word.
 */
export function InlineConfirm({
  message,
  announce,
  children,
  appearance = "bubble",
  duration,
  className,
  ...props
}: InlineConfirmProps) {
  const { active, confirm } = useInlineConfirm(duration);
  const mark = (
    <>
      <CheckIcon className="size-3.5 text-brand-fg" />
      {message}
    </>
  );
  return (
    <span className={cn("relative inline-flex items-center", appearance === "inline" && "gap-2", className)} {...props}>
      {children({ confirm, active })}
      {appearance === "bubble" ? (
        <span
          aria-hidden="true"
          data-open={active ? "" : undefined}
          className={cn(
            "pointer-events-none absolute bottom-full start-1/2 z-(--sb-z-popover) mb-1.5 inline-flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-lg bg-raised px-2 py-1 text-xs font-medium text-fg shadow-float",
            "origin-bottom transition-[opacity,translate,scale] duration-(--sb-duration-popup-out) ease-out",
            "translate-y-[calc(4px*var(--sb-move))] scale-(--sb-scale-popup) opacity-0",
            "data-open:translate-y-0 data-open:scale-100 data-open:opacity-100 data-open:duration-(--sb-duration-popup-in)",
          )}
        >
          {mark}
        </span>
      ) : (
        <span
          aria-hidden="true"
          data-open={active ? "" : undefined}
          className={cn(
            "inline-flex min-w-16 items-center gap-1 text-sm font-medium text-brand-fg",
            "-translate-x-[calc(4px*var(--sb-move))] opacity-0 transition-[opacity,translate] duration-(--sb-duration-popup-in) ease-out",
            "data-open:translate-x-0 data-open:opacity-100",
          )}
        >
          {mark}
        </span>
      )}
      <span role="status" className="sr-only">
        {active ? (announce ?? message) : ""}
      </span>
    </span>
  );
}
