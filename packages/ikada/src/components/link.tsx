import { useRender } from "@base-ui/react/use-render";
import { cn, focusRing } from "../lib/cn";
import { ArrowUpRightIcon } from "../lib/icons";

export interface LinkProps extends useRender.ComponentProps<"a"> {
  /** Opens in a new tab with a safe rel, shows an arrow and announces it. */
  external?: boolean;
}

/**
 * An inline link. Pass `render` to hand the element to a router:
 * `<Link render={<RouterLink to="/projects" />}>Sprouts</Link>`. ikada keeps the styles and
 * merges its props (class, ref, handlers) into the router's link.
 */
export function Link({ external = false, className, children, ref, render, ...props }: LinkProps) {
  return useRender({
    defaultTagName: "a",
    render,
    ref,
    props: {
      target: external ? "_blank" : undefined,
      rel: external ? "noopener noreferrer" : undefined,
      className: cn(
        "inline-flex items-center gap-1 rounded-xs font-medium text-fg underline decoration-hairline-strong decoration-1 underline-offset-4 transition-colors duration-(--sb-duration-hover) ease-hover",
        "hover:decoration-fg aria-disabled:pointer-events-none aria-disabled:opacity-55",
        focusRing,
        className,
      ),
      ...props,
      children: (
        <>
          {children}
          {external ? (
            <>
              <ArrowUpRightIcon className="size-3.5" />
              <span className="sr-only">(opens in a new tab)</span>
            </>
          ) : null}
        </>
      ),
    },
  });
}
