import { useRender } from "@base-ui/react/use-render";
import { Fragment } from "react";
import type { ComponentProps, ReactNode } from "react";
import { cn, coarseTarget, focusRing } from "../lib/cn";
import { ChevronRightIcon, MoreIcon } from "../lib/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu";

export interface BreadcrumbItem {
  label: ReactNode;
  /** Plain text label for the overflow menu when `label` is not a string. */
  text?: string;
  /** Stable key. Defaults to `href`, then `text`; give one to every item but the current page when it has neither. */
  id?: string;
  href?: string;
  /** Hand the link to a router: `<RouterLink to="/projects" />`. Used instead of `href`. */
  render?: useRender.ComponentProps<"a">["render"];
  onClick?: () => void;
}

export interface BreadcrumbsProps extends Omit<ComponentProps<"nav">, "children"> {
  /** Root first (Org, Project, Environment). The last item is the current page. */
  items: readonly BreadcrumbItem[];
  /** Past this many, the middle items collapse into a menu. The first and last always show. */
  maxItems?: number;
}

const linkStyles = cn(
  "rounded-xs px-0.5 text-fg-muted transition-colors duration-(--sb-duration-hover) ease-hover hover:text-fg hover:underline hover:underline-offset-4",
  coarseTarget,
  focusRing,
);

function Crumb({ item, current }: { item: BreadcrumbItem; current: boolean }) {
  // An undefined href would override the one on a router link, so only set it when there is one.
  const shared = { onClick: item.onClick, className: cn(linkStyles, "block truncate"), children: item.label };
  const linkProps = item.href === undefined ? shared : { ...shared, href: item.href };
  const link = useRender({
    defaultTagName: "a",
    render: item.render,
    enabled: !current && Boolean(item.href ?? item.render),
    props: linkProps,
  });
  if (current) {
    return (
      <span aria-current="page" className="block truncate font-medium text-fg">
        {item.label}
      </span>
    );
  }
  return (
    link ?? (
      <button type="button" onClick={item.onClick} className={cn(linkStyles, "block truncate")}>
        {item.label}
      </button>
    )
  );
}

/** Org > Project > Environment. A long trail collapses its middle into a "more" menu. */
export function Breadcrumbs({ items, maxItems = 4, className, ref, ...props }: BreadcrumbsProps) {
  const collapse = items.length > maxItems && maxItems >= 2;
  const tail = collapse ? items.slice(items.length - (maxItems - 1)) : [];
  const hidden = collapse ? items.slice(1, items.length - (maxItems - 1)) : [];
  const shown: (BreadcrumbItem | "more")[] = collapse ? [...items.slice(0, 1), "more", ...tail] : [...items];

  return (
    <nav ref={ref} aria-label="Breadcrumb" className={cn("min-w-0 text-base", className)} {...props}>
      <ol className="flex min-w-0 items-center gap-1">
        {shown.map((entry, i) => {
          const last = i === shown.length - 1;
          return (
            <Fragment key={entry === "more" ? "more" : (entry.id ?? entry.href ?? entry.text ?? "current")}>
              <li className={cn("flex min-w-0 items-center", last ? "shrink" : "shrink-[3]")}>
                {entry === "more" ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={`${hidden.length} more levels`}
                      className={cn(
                        "inline-grid size-7 place-items-center rounded-md text-fg-muted transition-colors duration-(--sb-duration-hover) ease-hover hover:bg-hover hover:text-fg pointer-coarse:size-11",
                        focusRing,
                      )}
                    >
                      <MoreIcon />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {hidden.map((h) => (
                        <DropdownMenuItem
                          key={h.id ?? h.href ?? h.text}
                          onClick={h.onClick}
                          render={
                            h.render ??
                            (h.href
                              ? (props) => (
                                  <a {...props} href={h.href}>
                                    {props.children}
                                  </a>
                                )
                              : undefined)
                          }
                        >
                          {h.text ?? h.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <Crumb item={entry} current={last} />
                )}
              </li>
              {last ? null : (
                <li aria-hidden="true" className="flex shrink-0 text-fg-muted">
                  <ChevronRightIcon className="size-3.5" />
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
