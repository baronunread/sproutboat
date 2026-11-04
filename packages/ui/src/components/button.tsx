import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentProps } from "react";
import type { VariantProps } from "tailwind-variants";
import { coarseTarget, focusRing, pressMotion, tv } from "../lib/cn";
import { SpinnerIcon } from "../lib/icons";

export const buttonStyles = tv({
  base: [
    "relative inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-semibold",
    pressMotion,
    // Optical alignment: the icon side gets 2px less padding than the text side.
    "has-[>svg:first-child:not(:only-child)]:ps-3 has-[>svg:last-child:not(:only-child)]:pe-3",
    "data-disabled:cursor-not-allowed data-disabled:opacity-50 data-disabled:active:scale-100",
    "data-loading:cursor-progress",
    focusRing,
    coarseTarget,
  ],
  variants: {
    variant: {
      primary: "bg-brand text-on-brand shadow-primary hover:bg-brand-hover",
      secondary: "bg-hover text-fg shadow-button hover:bg-[color-mix(in_oklch,var(--sb-hover),var(--sb-fg)_9%)]",
      ghost: "bg-transparent text-fg-muted hover:bg-hover hover:text-fg",
      danger:
        "bg-danger text-on-danger shadow-[inset_0_1px_0_oklch(1_0_0/0.18),0_1px_2px_oklch(0.3_0.1_25/0.3)] hover:bg-danger-hover",
    },
    size: {
      sm: "h-(--sb-control-h-sm) px-2.5 text-sm",
      md: "h-(--sb-control-h) px-3.5 text-base",
      lg: "h-11 px-4.5 text-base",
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
