import { Popover as BasePopover } from "@base-ui/react/popover";
import type { ComponentProps } from "react";
import { usePortalContainer } from "../lib/portal";
import { cn, floatingSurface, popupMotion, type WithClass } from "../lib/cn";
import { InstantProvider, instantAttr, useInstant, useInstantOpen } from "../lib/instant";

export function Popover({ onOpenChange, ...props }: ComponentProps<typeof BasePopover.Root>) {
  const [instant, handle] = useInstantOpen(onOpenChange);
  return (
    <InstantProvider value={instant}>
      <BasePopover.Root onOpenChange={handle} {...props} />
    </InstantProvider>
  );
}
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
  const instant = useInstant();
  const container = usePortalContainer();
  return (
    <BasePopover.Portal container={container}>
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
          {...instantAttr(instant)}
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
