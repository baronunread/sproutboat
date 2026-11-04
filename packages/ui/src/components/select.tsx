import { Select as BaseSelect } from "@base-ui/react/select";
import type { ComponentProps } from "react";
import { cn, coarseTarget, floatingSurface, focusRing, popupMotion } from "../lib/cn";
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
  ...props
}: SelectProps) {
  return (
    <BaseSelect.Root items={options} {...props}>
      <BaseSelect.Trigger
        ref={ref}
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        className={cn(
          "inline-flex h-(--sb-control-h) w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-control-edge bg-surface ps-3 pe-2.5 text-start text-base text-fg",
          "transition-[border-color,background-color] duration-(--sb-duration-fast) ease-standard hover:border-fg-muted",
          "data-popup-open:border-fg data-disabled:cursor-not-allowed data-disabled:bg-raised data-disabled:opacity-55",
          "aria-invalid:border-danger-dot data-invalid:border-danger-dot",
          focusRing,
          coarseTarget,
          className,
        )}
      >
        <BaseSelect.Value placeholder={<span className="text-fg-muted">{placeholder}</span>} className="truncate" />
        <BaseSelect.Icon className="text-fg-muted transition-transform duration-(--sb-duration-base) data-popup-open:rotate-180">
          <ChevronDownIcon />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          sideOffset={4}
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
          >
            <BaseSelect.List>
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="grid cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-md py-1.5 ps-2 pe-3 text-base outline-hidden select-none data-disabled:opacity-55 data-highlighted:bg-raised pointer-coarse:min-h-11"
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
  );
}
