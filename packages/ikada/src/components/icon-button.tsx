import { tv } from "../lib/cn";
import { Button } from "./button";
import type { ButtonProps } from "./button";
import { Tooltip } from "./tooltip";

const iconSize = tv({
  variants: {
    size: {
      sm: "size-(--sb-control-h-sm) px-0",
      md: "size-(--sb-control-h) px-0",
      lg: "size-10 px-0",
    },
  },
  defaultVariants: { size: "md" },
});

export interface IconButtonProps extends Omit<ButtonProps, "children" | "aria-label"> {
  /** Required. Becomes the accessible name and the tooltip text. */
  label: string;
  children: ButtonProps["children"];
  /** Set false when a parent already explains the button. */
  tooltip?: boolean;
}

export function IconButton({
  label,
  tooltip = true,
  size,
  variant = "ghost",
  className,
  children,
  ...props
}: IconButtonProps) {
  const button = (
    <Button aria-label={label} variant={variant} size={size} className={iconSize({ size, className })} {...props}>
      {children}
    </Button>
  );
  return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button;
}
