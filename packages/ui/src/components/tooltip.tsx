import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cn, floatingSurface } from "../lib/cn";

export const TooltipProvider = BaseTooltip.Provider;

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

export function Tooltip({ content, children, side = "top", delay = 400, defaultOpen, className, ref }: TooltipProps) {
  return (
    <BaseTooltip.Root defaultOpen={defaultOpen}>
      <BaseTooltip.Trigger render={children} delay={delay} />
      <BaseTooltip.Portal>
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
              "max-w-64 px-2 py-1 text-xs transition-opacity duration-(--sb-duration-fast) ease-standard data-starting-style:opacity-0 data-ending-style:opacity-0",
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
