import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ComponentProps } from "react";
import { cn, focusRing, type WithClass } from "../lib/cn";

export function Tabs({ className, ...props }: WithClass<ComponentProps<typeof BaseTabs.Root>>) {
  return <BaseTabs.Root className={cn("flex flex-col", className)} {...props} />;
}

/**
 * A 10px well (padding 4) holding 6px tabs. The raised pill is one element that slides
 * to the active tab over 250ms ease-in-out (the one in-out use: it moves across the screen).
 */
export function TabsList({ className, children, ...props }: WithClass<ComponentProps<typeof BaseTabs.List>>) {
  return (
    <BaseTabs.List
      className={cn(
        "relative inline-flex max-w-full gap-0.5 self-start overflow-x-auto rounded-lg bg-well p-1 [scrollbar-width:none]",
        className,
      )}
      {...props}
    >
      {children}
      <BaseTabs.Indicator
        className={cn(
          "absolute start-0 top-0 z-0 h-(--active-tab-height) w-(--active-tab-width) translate-x-(--active-tab-left) translate-y-(--active-tab-top) rounded-sm bg-raised shadow-pill",
          "[transition:translate_var(--sb-duration-slide)_var(--ease-in-out),width_var(--sb-duration-slide)_var(--ease-in-out)]",
          "motion-reduce:transition-none",
        )}
      />
    </BaseTabs.List>
  );
}

export function TabsTab({ className, ...props }: WithClass<ComponentProps<typeof BaseTabs.Tab>>) {
  return (
    <BaseTabs.Tab
      className={cn(
        "relative z-10 flex h-8 shrink-0 items-center whitespace-nowrap rounded-sm px-3 text-base font-semibold text-fg-muted",
        "[transition:color_var(--sb-duration-slide)_var(--ease-in-out)]",
        "hover:text-fg data-active:text-fg data-disabled:cursor-not-allowed data-disabled:opacity-50",
        "before:absolute before:inset-x-0 before:top-1/2 before:h-10 before:-translate-y-1/2 before:content-[''] pointer-fine:before:hidden",
        "pointer-coarse:min-h-11",
        focusRing,
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
