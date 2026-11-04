import { Popover as BasePopover } from "@base-ui/react/popover";
import type { ComponentProps } from "react";
import { cn, floatingSurface, popupMotion, type WithClass } from "../lib/cn";

export const Popover = BasePopover.Root;
export const PopoverTrigger = BasePopover.Trigger;
export const PopoverClose = BasePopover.Close;

export interface PopoverContentProps extends Omit<ComponentProps<typeof BasePopover.Popup>, "className"> {
  className?: string;
  side?: ComponentProps<typeof BasePopover.Positioner>["side"];
  align?: ComponentProps<typeof BasePopover.Positioner>["align"];
}

export function PopoverContent({
  className,
  side = "bottom",
  align = "start",
  children,
  ref,
  ...props
}: PopoverContentProps) {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner
        side={side}
        align={align}
        sideOffset={6}
        collisionPadding={8}
        className="z-(--sb-z-popover)"
      >
        <BasePopover.Popup
          ref={ref}
          className={cn(floatingSurface, popupMotion, "w-72 max-w-(--available-width) p-4 text-base", className)}
          {...props}
        >
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}

export function PopoverTitle({ className, ...props }: WithClass<ComponentProps<typeof BasePopover.Title>>) {
  return <BasePopover.Title className={cn("text-md font-semibold", className)} {...props} />;
}

export function PopoverDescription({ className, ...props }: WithClass<ComponentProps<typeof BasePopover.Description>>) {
  return <BasePopover.Description className={cn("mt-1 text-sm text-fg-muted", className)} {...props} />;
}
