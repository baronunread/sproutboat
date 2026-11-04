import { Field as BaseField } from "@base-ui/react/field";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { labelStyles } from "./label";

export interface FieldProps extends Omit<ComponentProps<typeof BaseField.Root>, "className" | "children"> {
  className?: string;
  label: ReactNode;
  description?: ReactNode;
  /** When set the field is invalid and the message is announced. */
  error?: ReactNode;
  required?: boolean;
  /** One control: Input, Select, Checkbox... Base UI wires id and aria. */
  children: ReactNode;
}

export function Field({
  label,
  description,
  error,
  required,
  className,
  children,
  invalid,
  ref,
  ...props
}: FieldProps) {
  return (
    <BaseField.Root
      ref={ref}
      invalid={invalid ?? Boolean(error)}
      className={cn("flex w-full flex-col gap-1.5", className)}
      {...props}
    >
      <BaseField.Label className={labelStyles}>
        {label}
        {required ? (
          <span aria-hidden="true" className="text-fg-muted">
            *
          </span>
        ) : null}
      </BaseField.Label>
      {children}
      {description ? (
        <BaseField.Description className="text-sm text-fg-muted">{description}</BaseField.Description>
      ) : null}
      <BaseField.Error match={Boolean(error)} className="flex items-start gap-1.5 text-sm text-danger-fg">
        {error}
      </BaseField.Error>
    </BaseField.Root>
  );
}
