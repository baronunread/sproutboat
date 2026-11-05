import { useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { cn, coarseTarget, focusRing } from "../lib/cn";
import { CloseIcon } from "../lib/icons";
import { softSurface } from "./status";
import type { Status } from "./status";
import { StatusGlyph } from "./status-glyph";

export interface BannerProps extends Omit<ComponentProps<"div">, "title"> {
  tone?: Status;
  title?: ReactNode;
  /** One action, usually a Button or Link. */
  action?: ReactNode;
  /** Shows a close button. The banner hides itself and calls `onDismiss`. */
  dismissible?: boolean;
  onDismiss?: () => void;
  dismissLabel?: string;
}

/**
 * An inline notice about the page it sits on: a deploy is blocked, a quota is near.
 * Never promotion. Danger interrupts (`role="alert"`); every other tone is polite.
 */
export function Banner({
  tone = "info",
  title,
  action,
  dismissible = false,
  onDismiss,
  dismissLabel = "Dismiss",
  className,
  children,
  ref,
  ...props
}: BannerProps) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <div
      ref={ref}
      role={tone === "danger" ? "alert" : "status"}
      data-tone={tone}
      className={cn("flex items-start gap-3 rounded-lg px-4 py-3 text-base", softSurface[tone], className)}
      {...props}
    >
      <StatusGlyph status={tone} className="mt-[5px]" />
      <div className="flex min-w-0 flex-1 flex-col gap-x-4 gap-y-2 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          {title ? <p className="font-semibold">{title}</p> : null}
          {children ? <div className={cn(title && "mt-0.5")}>{children}</div> : null}
        </div>
        {action ? <div className="shrink-0 text-fg">{action}</div> : null}
      </div>
      {dismissible ? (
        <button
          type="button"
          aria-label={dismissLabel}
          onClick={() => {
            setOpen(false);
            onDismiss?.();
          }}
          className={cn(
            "-me-1.5 -mt-1 inline-grid size-8 shrink-0 place-items-center rounded-md transition-colors duration-(--sb-duration-hover) ease-hover hover:bg-fg/10",
            coarseTarget,
            focusRing,
          )}
        >
          <CloseIcon />
        </button>
      ) : null}
    </div>
  );
}
