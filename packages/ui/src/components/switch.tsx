import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { useId } from "react";
import type { ComponentProps, ReactNode } from "react";
import { cn, focusRing } from "../lib/cn";

export interface SwitchProps extends Omit<ComponentProps<typeof BaseSwitch.Root>, "className" | "children"> {
  className?: string;
  label?: ReactNode;
}

export function Switch({ label, className, id, ref, ...props }: SwitchProps) {
  const autoId = useId();
  const controlId = id ?? autoId;
  const control = (
    <BaseSwitch.Root
      ref={ref}
      id={controlId}
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full bg-hover p-[3px]",
        "shadow-[inset_0_0_0_1.5px_var(--sb-control-edge)]",
        "transition-[background-color,box-shadow] duration-(--sb-duration-hover) ease-hover",
        "hover:shadow-[inset_0_0_0_1.5px_var(--sb-fg-muted)] data-checked:bg-brand data-checked:shadow-none",
        "data-disabled:cursor-not-allowed data-disabled:opacity-50",
        "before:absolute before:-inset-2 before:content-[''] pointer-fine:before:hidden",
        focusRing,
        !label && className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb
        className={cn(
          "block size-[18px] rounded-full bg-fg-muted shadow-[0_1px_2px_oklch(0_0_0/0.25)]",
          "[transition:translate_var(--sb-duration-dialog-in)_var(--ease-out),background-color_var(--sb-duration-hover)_var(--ease-hover)]",
          "data-checked:translate-x-4 data-checked:bg-on-brand rtl:data-checked:-translate-x-4",
          "motion-reduce:[transition:background-color_var(--sb-duration-hover)_var(--ease-hover)]",
        )}
      />
    </BaseSwitch.Root>
  );
  if (!label) return control;
  return (
    <label htmlFor={controlId} className={cn("inline-flex items-center gap-2.5 text-base text-fg", className)}>
      {control}
      <span>{label}</span>
    </label>
  );
}
