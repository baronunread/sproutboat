import { Select as BaseSelect } from "@base-ui/react/select";
import type { ComponentProps } from "react";
import { cn, coarseTarget, fieldSurface, floatingSurface, focusRing, popupMotion } from "../lib/cn";
import { usePortalContainer } from "../lib/portal";
import { InstantProvider, instantAttr, useInstantOpen } from "../lib/instant";
import { CheckIcon, ChevronDownIcon } from "../lib/icons";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<
  ComponentProps<typeof BaseSelect.Root<string>>,
  "children" | "items" | "className"
> {
  options: readonly SelectOption[];
  placeholder?: string;
  invalid?: boolean;
  className?: string;
  /** Accessible name when there is no Field label. */
  "aria-label"?: string;
  id?: string;
  ref?: ComponentProps<"button">["ref"];
}

export function Select({
  options,
  placeholder = "Select...",
  invalid,
  className,
  id,
  ref,
  "aria-label": ariaLabel,
  onOpenChange,
  ...props
}: SelectProps) {
  const [instant, handle] = useInstantOpen(onOpenChange);
  const container = usePortalContainer();
  return (
    <InstantProvider value={instant}>
      <BaseSelect.Root items={options} onOpenChange={handle} {...props}>
        <BaseSelect.Trigger
          ref={ref}
          id={id}
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          className={cn(
            "inline-flex h-(--sb-control-h) w-full min-w-0 items-center justify-between gap-2 ps-3 pe-2.5 text-start text-base",
            fieldSurface,
            "data-popup-open:shadow-field-hover",
            focusRing,
            coarseTarget,
            className,
          )}
        >
          <BaseSelect.Value placeholder={<span className="text-fg-muted">{placeholder}</span>} className="truncate" />
          <BaseSelect.Icon className="text-fg-muted transition-[rotate] duration-200 ease-out data-popup-open:rotate-180 motion-reduce:transition-none">
            <ChevronDownIcon />
          </BaseSelect.Icon>
        </BaseSelect.Trigger>
        <BaseSelect.Portal container={container}>
          <BaseSelect.Positioner
            sideOffset={6}
            collisionPadding={8}
            alignItemWithTrigger={false}
            className="z-(--sb-z-popover)"
          >
            <BaseSelect.Popup
              className={cn(
                floatingSurface,
                popupMotion,
                "max-h-(--available-height) min-w-(--anchor-width) overflow-y-auto p-1",
              )}
              {...instantAttr(instant)}
            >
              <BaseSelect.List>
                {options.map((option) => (
                  <BaseSelect.Item
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    className="grid min-h-9 cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-md py-1.5 ps-2.5 pe-3 text-base outline-hidden transition-colors duration-(--sb-duration-hover) ease-hover select-none data-disabled:opacity-50 data-highlighted:bg-hover data-selected:font-semibold pointer-coarse:min-h-11"
                  >
                    <BaseSelect.ItemIndicator className="col-start-1">
                      <CheckIcon />
                    </BaseSelect.ItemIndicator>
                    <BaseSelect.ItemText className="col-start-2">{option.label}</BaseSelect.ItemText>
                  </BaseSelect.Item>
                ))}
              </BaseSelect.List>
            </BaseSelect.Popup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
    </InstantProvider>
  );
}
