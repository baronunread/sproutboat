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
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-control-edge bg-raised p-0.5",
        "transition-[background-color,border-color] duration-(--sb-duration-base) ease-standard",
        "hover:border-fg-muted data-checked:border-brand data-checked:bg-brand",
        "data-disabled:cursor-not-allowed data-disabled:opacity-55",
        "before:absolute before:-inset-2 before:content-[''] pointer-fine:before:hidden",
        focusRing,
        !label && className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb
        className={cn(
          "block size-3.5 rounded-full bg-control-edge transition-transform duration-(--sb-duration-base) ease-standard",
          "data-checked:translate-x-4 data-checked:bg-on-brand rtl:data-checked:-translate-x-4",
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
