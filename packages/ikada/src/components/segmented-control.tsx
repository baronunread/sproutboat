import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { ReactNode } from "react";
import { cn, coarseTarget, focusRing } from "../lib/cn";

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: ReactNode;
  /** Plain text name when `label` is only an icon. */
  ariaLabel?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string = string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  /** Names the group, e.g. "Theme". Required. */
  "aria-label": string;
  size?: "sm" | "md";
  className?: string;
}

/**
 * One choice out of a few, always one selected (a click on the selected segment does nothing).
 * Arrow keys move between segments; Space or Enter selects.
 */
export function SegmentedControl<T extends string = string>({
  options,
  value,
  onValueChange,
  size = "md",
  className,
  "aria-label": ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroup
      aria-label={ariaLabel}
      value={[value]}
      onValueChange={(next) => {
        const chosen = options.find((option) => option.value === next[0]);
        if (chosen) onValueChange(chosen.value);
      }}
      className={cn("inline-flex w-full gap-0.5 rounded-lg bg-well p-0.5 shadow-field", className)}
    >
      {options.map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          aria-label={option.ariaLabel}
          className={cn(
            "inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-semibold text-fg-muted",
            "transition-[background-color,color,box-shadow] duration-(--sb-duration-hover) ease-hover hover:text-fg",
            "data-pressed:bg-raised data-pressed:text-fg data-pressed:shadow-pill",
            "data-disabled:cursor-not-allowed data-disabled:opacity-50",
            size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-3 text-sm",
            coarseTarget,
            focusRing,
          )}
        >
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
