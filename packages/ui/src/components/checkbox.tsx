import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { useId } from "react";
import type { ComponentProps, ReactNode } from "react";
import { cn, focusRing } from "../lib/cn";
import { CheckIcon, MinusIcon } from "../lib/icons";

export interface CheckboxProps extends Omit<ComponentProps<typeof BaseCheckbox.Root>, "className" | "children"> {
  className?: string;
  /** Visible label. Without one, pass aria-label. */
  label?: ReactNode;
  description?: ReactNode;
  invalid?: boolean;
}

export function Checkbox({ label, description, invalid, className, id, ref, ...props }: CheckboxProps) {
  const autoId = useId();
  const controlId = id ?? autoId;
  const box = (
    <BaseCheckbox.Root
      ref={ref}
      id={controlId}
      aria-invalid={invalid || undefined}
      className={cn(
        "mt-px inline-flex size-4.5 shrink-0 items-center justify-center rounded-xs bg-well text-on-brand",
        "shadow-[inset_0_0_0_1.5px_var(--sb-control-edge)]",
        "transition-[background-color,box-shadow] duration-(--sb-duration-hover) ease-hover",
        "hover:shadow-[inset_0_0_0_1.5px_var(--sb-fg-muted)]",
        "data-checked:bg-brand data-checked:shadow-none data-indeterminate:bg-brand data-indeterminate:shadow-none",
        "data-disabled:cursor-not-allowed data-disabled:opacity-50",
        "aria-invalid:shadow-[inset_0_0_0_1.5px_var(--sb-danger-dot)]",
        "relative before:absolute before:-inset-3 before:content-[''] pointer-fine:before:hidden",
        focusRing,
        !label && className,
      )}
      {...props}
    >
      <BaseCheckbox.Indicator
        className={cn(
          "flex transition-[opacity,scale] duration-(--sb-duration-hover) ease-out",
          "data-starting-style:scale-(--sb-scale-icon) data-starting-style:opacity-0",
          "data-ending-style:scale-(--sb-scale-icon) data-ending-style:opacity-0",
        )}
        keepMounted={false}
      >
        <IndicatorIcon indeterminate={props.indeterminate} />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
  if (!label) return box;
  return (
    <label htmlFor={controlId} className={cn("inline-flex items-start gap-2.5 text-base text-fg", className)}>
      {box}
      <span className="flex flex-col">
        <span>{label}</span>
        {description ? <span className="text-sm text-fg-muted">{description}</span> : null}
      </span>
    </label>
  );
}

function IndicatorIcon({ indeterminate }: { indeterminate?: boolean }) {
  return indeterminate ? <MinusIcon className="size-3.5" /> : <CheckIcon className="size-3.5" />;
}
