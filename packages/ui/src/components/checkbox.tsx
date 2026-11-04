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
        "mt-px inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-control-edge bg-surface text-on-brand",
        "transition-[background-color,border-color] duration-(--sb-duration-fast) ease-standard",
        "hover:border-fg-muted data-checked:border-brand data-checked:bg-brand data-indeterminate:border-brand data-indeterminate:bg-brand",
        "data-disabled:cursor-not-allowed data-disabled:opacity-55 aria-invalid:border-danger-dot",
        "relative before:absolute before:-inset-3 before:content-[''] pointer-fine:before:hidden",
        focusRing,
        !label && className,
      )}
      {...props}
    >
      <BaseCheckbox.Indicator className="flex data-unchecked:hidden" keepMounted={false}>
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
