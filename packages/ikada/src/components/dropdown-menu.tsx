import { Menu } from "@base-ui/react/menu";
import type { ComponentProps } from "react";
import { cn, floatingSurface, popupMotion, type WithClass } from "../lib/cn";
import { InstantProvider, instantAttr, useInstant, useInstantOpen } from "../lib/instant";
import { CheckIcon } from "../lib/icons";
import { usePortalContainer } from "../lib/portal";

export function DropdownMenu({ onOpenChange, ...props }: ComponentProps<typeof Menu.Root>) {
  const [instant, handle] = useInstantOpen(onOpenChange);
  return (
    <InstantProvider value={instant}>
      <Menu.Root onOpenChange={handle} {...props} />
    </InstantProvider>
  );
}
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuGroup = Menu.Group;

export interface DropdownMenuContentProps extends Omit<ComponentProps<typeof Menu.Popup>, "className"> {
  className?: string;
  side?: ComponentProps<typeof Menu.Positioner>["side"];
  align?: ComponentProps<typeof Menu.Positioner>["align"];
}

/**
 * A 12px layer holding 8px items with 4px padding (8 + 4). When any child is a checkbox
 * item, every item gets the same fixed 1.5rem gutter (--sb-gutter), so item text lines up
 * whether or not that row shows a check.
 */
export function DropdownMenuContent({
  className,
  side = "bottom",
  align = "end",
  children,
  ref,
  ...props
}: DropdownMenuContentProps) {
  const instant = useInstant();
  const container = usePortalContainer();
  return (
    <Menu.Portal container={container}>
      <Menu.Positioner side={side} align={align} sideOffset={6} collisionPadding={8} className="z-(--sb-z-dropdown)">
        <Menu.Popup
          ref={ref}
          className={cn(
            floatingSurface,
            popupMotion,
            "min-w-48 p-1 text-base [--sb-gutter:0rem] has-[[role=menuitemcheckbox]]:[--sb-gutter:1.5rem] has-[[role=menuitemradio]]:[--sb-gutter:1.5rem]",
            className,
          )}
          {...instantAttr(instant)}
          {...props}
        >
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

const itemStyles = [
  "relative flex min-h-9 cursor-default items-center gap-2 rounded-md py-1.5 pe-2.5 ps-[calc(0.625rem+var(--sb-gutter))] text-base outline-hidden select-none",
  "transition-colors duration-(--sb-duration-hover) ease-hover",
  "data-disabled:opacity-50 data-highlighted:bg-hover pointer-coarse:min-h-11",
].join(" ");

export interface DropdownMenuItemProps extends Omit<ComponentProps<typeof Menu.Item>, "className"> {
  className?: string;
  /** Destructive items use the danger text color. */
  destructive?: boolean;
}

export function DropdownMenuItem({ className, destructive = false, ...props }: DropdownMenuItemProps) {
  return <Menu.Item className={cn(itemStyles, destructive && "text-danger-fg", className)} {...props} />;
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: WithClass<ComponentProps<typeof Menu.CheckboxItem>>) {
  return (
    <Menu.CheckboxItem className={cn(itemStyles, className)} {...props}>
      <span aria-hidden="true" className="absolute start-2.5 grid size-4 place-items-center">
        <Menu.CheckboxItemIndicator
          className={cn(
            "flex transition-[opacity,scale] duration-(--sb-duration-hover) ease-out",
            "data-starting-style:scale-(--sb-scale-icon) data-starting-style:opacity-0",
            "data-ending-style:scale-(--sb-scale-icon) data-ending-style:opacity-0",
          )}
        >
          <CheckIcon />
        </Menu.CheckboxItemIndicator>
      </span>
      {children}
    </Menu.CheckboxItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: WithClass<ComponentProps<typeof Menu.GroupLabel>>) {
  return (
    <Menu.GroupLabel className={cn("px-2.5 pt-1.5 pb-1 text-xs font-semibold text-fg-muted", className)} {...props} />
  );
}

export function DropdownMenuSeparator({ className, ...props }: WithClass<ComponentProps<typeof Menu.Separator>>) {
  return <Menu.Separator className={cn("mx-1.5 my-1 h-px bg-hairline-strong/70", className)} {...props} />;
}
