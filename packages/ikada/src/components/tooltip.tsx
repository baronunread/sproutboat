import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cn, floatingSurface } from "../lib/cn";
import { usePortalContainer } from "../lib/portal";

/**
 * Warm skip-delay: the first tooltip waits 450ms; once one has closed, neighbours open
 * with no delay and no animation for 300ms, so sweeping a toolbar feels instant.
 */
export function TooltipProvider({ delay = 450, timeout = 300, ...props }: ComponentProps<typeof BaseTooltip.Provider>) {
  return <BaseTooltip.Provider delay={delay} timeout={timeout} {...props} />;
}

export interface TooltipProps {
  /** Short plain text. Anything interactive belongs in a Popover. */
  content: ReactNode;
  /** The element that triggers the tooltip; it receives the trigger props. */
  children: ReactElement;
  side?: "top" | "bottom" | "start" | "end";
  delay?: number;
  defaultOpen?: boolean;
  className?: string;
  ref?: ComponentProps<"div">["ref"];
}

export function Tooltip({ content, children, side = "top", delay, defaultOpen, className, ref }: TooltipProps) {
  const container = usePortalContainer();
  return (
    <BaseTooltip.Root defaultOpen={defaultOpen}>
      <BaseTooltip.Trigger render={children} delay={delay} />
      <BaseTooltip.Portal container={container}>
        <BaseTooltip.Positioner
          side={side === "start" ? "inline-start" : side === "end" ? "inline-end" : side}
          sideOffset={6}
          collisionPadding={8}
          className="z-(--sb-z-tooltip)"
        >
          <BaseTooltip.Popup
            ref={ref}
            className={cn(
              floatingSurface,
              "max-w-64 rounded-md px-2.5 py-1.5 text-xs font-medium",
              "origin-(--transform-origin) transition-[opacity,scale] duration-(--sb-duration-tooltip-out) ease-out",
              "data-open:duration-(--sb-duration-tooltip-in)",
              "data-starting-style:scale-(--sb-scale-popup) data-starting-style:opacity-0",
              "data-ending-style:scale-(--sb-scale-popup) data-ending-style:opacity-0",
              "data-instant:transition-none",
              className,
            )}
          >
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
