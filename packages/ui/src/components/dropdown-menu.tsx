import { Menu } from "@base-ui/react/menu";
import type { ComponentProps } from "react";
import { cn, floatingSurface, popupMotion, type WithClass } from "../lib/cn";
import { CheckIcon } from "../lib/icons";

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuGroup = Menu.Group;

export interface DropdownMenuContentProps extends Omit<ComponentProps<typeof Menu.Popup>, "className"> {
  className?: string;
  side?: ComponentProps<typeof Menu.Positioner>["side"];
  align?: ComponentProps<typeof Menu.Positioner>["align"];
}

export function DropdownMenuContent({
  className,
  side = "bottom",
  align = "end",
  children,
  ref,
  ...props
}: DropdownMenuContentProps) {
  return (
    <Menu.Portal>
      <Menu.Positioner side={side} align={align} sideOffset={4} collisionPadding={8} className="z-(--sb-z-dropdown)">
        <Menu.Popup
          ref={ref}
          className={cn(floatingSurface, popupMotion, "min-w-44 p-1 text-base", className)}
          {...props}
        >
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

const itemStyles =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-base outline-hidden select-none data-disabled:opacity-55 data-highlighted:bg-raised pointer-coarse:min-h-11";

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
    <Menu.CheckboxItem className={cn(itemStyles, "ps-8 relative", className)} {...props}>
      <Menu.CheckboxItemIndicator className="absolute start-2">
        <CheckIcon />
      </Menu.CheckboxItemIndicator>
      {children}
    </Menu.CheckboxItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: WithClass<ComponentProps<typeof Menu.GroupLabel>>) {
  return <Menu.GroupLabel className={cn("px-2 py-1 text-xs font-medium text-fg-muted", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: WithClass<ComponentProps<typeof Menu.Separator>>) {
  return <Menu.Separator className={cn("my-1 h-px bg-hairline", className)} {...props} />;
}
