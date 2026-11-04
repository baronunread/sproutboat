import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentProps } from "react";
import type { VariantProps } from "tailwind-variants";
import { coarseTarget, focusRing, tv } from "../lib/cn";
import { SpinnerIcon } from "../lib/icons";

export const buttonStyles = tv({
  base: [
    "relative inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md border font-medium",
    "transition-[background-color,border-color,color,transform] duration-(--sb-duration-fast) ease-standard",
    "active:translate-y-px",
    "data-disabled:cursor-not-allowed data-disabled:opacity-55 data-disabled:active:translate-y-0",
    "data-loading:cursor-progress",
    focusRing,
    coarseTarget,
  ],
  variants: {
    variant: {
      primary: "border-brand bg-brand text-on-brand hover:border-brand-hover hover:bg-brand-hover",
      secondary: "border-hairline-strong bg-surface text-fg hover:bg-raised",
      ghost: "border-transparent bg-transparent text-fg hover:bg-raised",
      danger: "border-danger bg-danger text-on-danger hover:border-danger-hover hover:bg-danger-hover",
    },
    size: {
      sm: "h-(--sb-control-h-sm) px-2.5 text-sm",
      md: "h-(--sb-control-h) px-3.5 text-base",
      lg: "h-10 px-4 text-base",
    },
  },
  defaultVariants: { variant: "secondary", size: "md" },
});

export type ButtonVariants = VariantProps<typeof buttonStyles>;

export interface ButtonProps extends Omit<ComponentProps<typeof BaseButton>, "className">, ButtonVariants {
  className?: string;
  /** Shows a spinner, sets aria-busy, ignores clicks, keeps the width and focus. */
  loading?: boolean;
}

export function Button({
  variant,
  size,
  loading = false,
  disabled,
  className,
  children,
  onClick,
  ref,
  ...props
}: ButtonProps) {
  return (
    <BaseButton
      ref={ref}
      disabled={disabled || loading}
      focusableWhenDisabled={loading}
      aria-busy={loading || undefined}
      data-loading={loading ? "" : undefined}
      onClick={loading ? undefined : onClick}
      className={buttonStyles({ variant, size, className })}
      {...props}
    >
      {loading ? (
        <>
          <span className="inline-flex items-center gap-2 opacity-0">{children}</span>
          <SpinnerIcon className="absolute" />
        </>
      ) : (
        children
      )}
    </BaseButton>
  );
}
