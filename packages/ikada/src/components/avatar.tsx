import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import type { ComponentProps } from "react";
import { cn, tv } from "../lib/cn";

const avatarStyles = tv({
  base: "inline-grid shrink-0 select-none place-items-center overflow-hidden bg-hover font-semibold text-fg shadow-pill",
  variants: {
    size: {
      sm: "size-6 rounded-md text-xs",
      md: "size-8 rounded-lg text-sm",
      lg: "size-12 rounded-xl text-lg",
    },
  },
  defaultVariants: { size: "md" },
});

export interface AvatarProps extends Omit<ComponentProps<typeof BaseAvatar.Root>, "children" | "className"> {
  /** The picture URL. A missing or broken image falls back to the initial. */
  src?: string | null;
  /** Whose avatar it is. Becomes the image alt text; its first letter is the fallback. */
  name: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

/** A person's picture with their initial when there is none (or it fails to load). Decorative next to a visible name. */
export function Avatar({ src, name, size, className, ref, ...props }: AvatarProps) {
  return (
    <BaseAvatar.Root ref={ref} className={cn(avatarStyles({ size }), className)} {...props}>
      {src ? <BaseAvatar.Image src={src} alt={`${name} avatar`} className="size-full object-cover" /> : null}
      <BaseAvatar.Fallback aria-hidden="true" delay={src ? 400 : 0}>
        {name.trim().slice(0, 1).toUpperCase() || "?"}
      </BaseAvatar.Fallback>
    </BaseAvatar.Root>
  );
}
