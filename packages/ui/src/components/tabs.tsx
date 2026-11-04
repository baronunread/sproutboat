import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ComponentProps } from "react";
import { cn, focusRingInset, type WithClass } from "../lib/cn";

export function Tabs({ className, ...props }: WithClass<ComponentProps<typeof BaseTabs.Root>>) {
  return <BaseTabs.Root className={cn("flex flex-col", className)} {...props} />;
}

export function TabsList({ className, ...props }: WithClass<ComponentProps<typeof BaseTabs.List>>) {
  return (
    <BaseTabs.List
      className={cn("flex gap-0.5 overflow-x-auto border-b border-hairline [scrollbar-width:thin]", className)}
      {...props}
    />
  );
}

export function TabsTab({ className, ...props }: WithClass<ComponentProps<typeof BaseTabs.Tab>>) {
  return (
    <BaseTabs.Tab
      className={cn(
        "relative flex h-10 shrink-0 items-center whitespace-nowrap rounded-t-md px-3 text-base font-medium text-fg-muted",
        "transition-colors duration-(--sb-duration-fast) ease-standard hover:text-fg",
        "data-active:text-fg data-disabled:cursor-not-allowed data-disabled:opacity-55",
        "after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:bg-transparent data-active:after:bg-fg",
        "pointer-coarse:min-h-11",
        focusRingInset,
        className,
      )}
      {...props}
    />
  );
}

export function TabsPanel({ className, ...props }: WithClass<ComponentProps<typeof BaseTabs.Panel>>) {
  return (
    <BaseTabs.Panel
      className={cn(
        "pt-4 outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        className,
      )}
      {...props}
    />
  );
}
