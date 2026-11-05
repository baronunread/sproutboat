import { Radio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import { useId } from "react";
import type { ComponentProps, ReactNode } from "react";
import { cn, focusRing } from "../lib/cn";

export interface RadioOption {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps extends Omit<ComponentProps<typeof BaseRadioGroup>, "className" | "children"> {
  options: readonly RadioOption[];
  /** The group's visible name. Without one, pass `aria-label`. */
  legend?: ReactNode;
  invalid?: boolean;
  /** `horizontal` lays the options in a wrapping row. */
  orientation?: "vertical" | "horizontal";
  className?: string;
}

/** One choice out of a few, all visible. Arrow keys move and select; Tab leaves the group. */
export function RadioGroup({
  options,
  legend,
  invalid,
  orientation = "vertical",
  className,
  ref,
  ...props
}: RadioGroupProps) {
  const legendId = useId();
  return (
    <BaseRadioGroup
      ref={ref}
      aria-labelledby={legend ? legendId : undefined}
      aria-invalid={invalid || undefined}
      className={cn("flex flex-col gap-2", className)}
      {...props}
    >
      {legend ? (
        <span id={legendId} className="text-sm font-semibold text-fg">
          {legend}
        </span>
      ) : null}
      <div className={cn("flex gap-x-5 gap-y-2.5", orientation === "vertical" ? "flex-col" : "flex-row flex-wrap")}>
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              "inline-flex items-start gap-2.5 text-base text-fg",
              option.disabled && "cursor-not-allowed opacity-50",
            )}
          >
            <Radio.Root
              value={option.value}
              disabled={option.disabled}
              className={cn(
                "relative mt-px inline-flex size-4.5 shrink-0 items-center justify-center rounded-full bg-well",
                "shadow-[inset_0_0_0_1.5px_var(--sb-control-edge)]",
                "transition-[background-color,box-shadow] duration-(--sb-duration-hover) ease-hover",
                "hover:shadow-[inset_0_0_0_1.5px_var(--sb-fg-muted)]",
                "data-checked:bg-brand data-checked:shadow-none",
                "data-disabled:cursor-not-allowed",
                "before:absolute before:-inset-3 before:content-[''] pointer-fine:before:hidden",
                invalid && "shadow-[inset_0_0_0_1.5px_var(--sb-danger-dot)]",
                focusRing,
              )}
            >
              <Radio.Indicator
                keepMounted={false}
                className="size-1.5 rounded-full bg-on-brand transition-[opacity,scale] duration-(--sb-duration-hover) ease-out data-starting-style:scale-(--sb-scale-icon) data-starting-style:opacity-0"
              />
            </Radio.Root>
            <span className="flex flex-col">
              <span>{option.label}</span>
              {option.description ? <span className="text-sm text-fg-muted">{option.description}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </BaseRadioGroup>
  );
}
