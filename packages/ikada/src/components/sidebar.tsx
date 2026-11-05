import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useRender } from "@base-ui/react/use-render";
import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore } from "react";
import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { cn, coarseTarget, focusRing, type WithClass } from "../lib/cn";
import { MenuIcon, SidebarIcon } from "../lib/icons";
import { usePortalContainer } from "../lib/portal";
import { Tooltip } from "./tooltip";

const DESKTOP = "(min-width: 48rem)";
const subscribe = (cb: () => void) => {
  const mq = globalThis.matchMedia?.(DESKTOP);
  if (!mq) return () => {};
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const snapshot = () => globalThis.matchMedia?.(DESKTOP).matches ?? true;
/** True from 768px up. Server and tests without matchMedia count as desktop. */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}

interface SidebarContextValue {
  rail: boolean;
  drawer: boolean;
  closeDrawer: () => void;
}
const SidebarContext = createContext<SidebarContextValue>({ rail: false, drawer: false, closeDrawer: () => {} });

export interface SidebarProps extends Omit<ComponentProps<"aside">, "children"> {
  children: ReactNode;
  /** `static` is always a column, `drawer` is always an overlay, `auto` switches at 768px. */
  mode?: "auto" | "static" | "drawer";
  /** Icon-only rail (desktop only). Controlled. */
  collapsed?: boolean;
  /** Mobile drawer state. Controlled. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Accessible name of the drawer dialog. */
  drawerLabel?: string;
}

/**
 * The account navigation. On desktop a 240px column (or a 56px icon rail); on mobile a
 * modal drawer that traps focus, closes on Escape or scrim click and returns focus to the
 * trigger. Only one copy of the content is in the DOM at a time.
 */
export function Sidebar({
  children,
  mode = "auto",
  collapsed = false,
  open = false,
  onOpenChange,
  drawerLabel = "Navigation",
  className,
  ref,
  ...props
}: SidebarProps) {
  const isDesktop = useIsDesktop();
  const drawer = mode === "drawer" || (mode === "auto" && !isDesktop);
  const container = usePortalContainer();
  const closeDrawer = useCallback(() => onOpenChange?.(false), [onOpenChange]);
  const drawerContext = useMemo(() => ({ rail: false, drawer: true, closeDrawer }), [closeDrawer]);
  const columnContext = useMemo(() => ({ rail: collapsed, drawer: false, closeDrawer }), [collapsed, closeDrawer]);

  if (drawer) {
    const place = container ? "absolute" : "fixed";
    return (
      <BaseDialog.Root open={open} onOpenChange={(next) => onOpenChange?.(next)} modal>
        <BaseDialog.Portal container={container}>
          <BaseDialog.Backdrop
            className={cn(
              place,
              "inset-0 z-(--sb-z-overlay) bg-scrim",
              "transition-opacity duration-(--sb-duration-dialog-out) ease-out data-open:duration-(--sb-duration-dialog-in)",
              "data-starting-style:opacity-0 data-ending-style:opacity-0",
            )}
          />
          <BaseDialog.Popup
            className={cn(
              place,
              "inset-y-0 start-0 z-(--sb-z-modal) flex w-72 max-w-[85%] flex-col bg-surface text-fg shadow-dialog outline-hidden",
              "transition-[translate,opacity] duration-(--sb-duration-slide) ease-out data-ending-style:duration-(--sb-duration-dialog-out)",
              "data-starting-style:-translate-x-[calc(100%*var(--sb-move))] data-starting-style:opacity-0",
              "data-ending-style:-translate-x-[calc(100%*var(--sb-move))] data-ending-style:opacity-0",
              className,
            )}
          >
            <BaseDialog.Title className="sr-only">{drawerLabel}</BaseDialog.Title>
            <SidebarContext value={drawerContext}>
              <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3">{children}</div>
            </SidebarContext>
          </BaseDialog.Popup>
        </BaseDialog.Portal>
      </BaseDialog.Root>
    );
  }

  return (
    <aside
      ref={ref}
      data-collapsed={collapsed || undefined}
      className={cn(
        "flex h-full shrink-0 flex-col gap-1 overflow-y-auto overflow-x-hidden bg-surface p-3 text-fg shadow-[inset_-1px_0_0_var(--sb-hairline)]",
        "w-60 transition-[width] duration-(--sb-duration-slide) ease-in-out motion-reduce:transition-none",
        collapsed && "w-14 px-2",
        className,
      )}
      {...props}
    >
      <SidebarContext value={columnContext}>{children}</SidebarContext>
    </aside>
  );
}

export function SidebarHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mb-2 flex items-center gap-2 px-1 pt-1", className)} {...props} />;
}

export function SidebarFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mt-auto flex flex-col gap-1 border-t border-hairline pt-3", className)} {...props} />;
}

/** A flat list of links. Give each group a `label`; there is no nesting. */
export function SidebarNav({
  label = "Account",
  className,
  children,
  ...props
}: ComponentProps<"nav"> & { label?: string }) {
  return (
    <nav aria-label={label} className={className} {...props}>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </nav>
  );
}

export interface SidebarItemProps extends WithClass<Omit<useRender.ComponentProps<"a">, "children">> {
  /** Plain destination. With a router, leave it out and pass `render={<RouterLink to="/x" />}`. */
  href?: string;
  icon?: ReactNode;
  /** Marks the page you are on: `aria-current="page"` and a raised fill. */
  current?: boolean;
  /** Trailing text or a Badge, hidden in the rail. */
  trailing?: ReactNode;
  children: string;
}

/** In the rail the label hides visually (it stays the accessible name) and a tooltip shows it. */
export function SidebarItem({
  icon,
  current = false,
  trailing,
  className,
  children,
  onClick,
  ref,
  render,
  ...props
}: SidebarItemProps) {
  const { rail, drawer, closeDrawer } = useContext(SidebarContext);
  const link = useRender({
    defaultTagName: "a",
    render,
    ref,
    props: {
      "aria-current": current ? "page" : undefined,
      onClick: (e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (drawer) closeDrawer();
      },
      className: cn(
        "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-base font-medium text-fg-muted",
        "transition-colors duration-(--sb-duration-hover) ease-hover hover:bg-hover hover:text-fg",
        "aria-[current=page]:bg-hover aria-[current=page]:text-fg aria-[current=page]:shadow-pill",
        rail && "justify-center px-0",
        "pointer-coarse:h-11",
        focusRing,
        className,
      ),
      ...props,
      children: (
        <>
          {icon}
          <span className={cn("min-w-0 flex-1 truncate", rail && "sr-only")}>{children}</span>
          {rail ? null : trailing}
        </>
      ),
    },
  });
  return (
    <li>
      {rail ? (
        <Tooltip content={children} side="end">
          {link}
        </Tooltip>
      ) : (
        link
      )}
    </li>
  );
}

/** Collapses the desktop column to a rail. Renders nothing in the drawer. */
export function SidebarToggle({
  collapsed,
  onCollapsedChange,
  className,
  ...props
}: Omit<ComponentProps<"button">, "onClick"> & {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const { drawer } = useContext(SidebarContext);
  if (drawer) return null;
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <Tooltip content={label} side="end">
      <button
        type="button"
        aria-label={label}
        aria-expanded={!collapsed}
        onClick={() => onCollapsedChange(!collapsed)}
        className={cn(
          "inline-grid size-9 shrink-0 place-items-center rounded-md text-fg-muted transition-colors duration-(--sb-duration-hover) ease-hover hover:bg-hover hover:text-fg",
          coarseTarget,
          focusRing,
          className,
        )}
        {...props}
      >
        <SidebarIcon />
      </button>
    </Tooltip>
  );
}

/** The button that opens the drawer: show it where the sidebar is not a column. */
export function SidebarTrigger({
  className,
  label = "Open navigation",
  ...props
}: ComponentProps<"button"> & { label?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="dialog"
      className={cn(
        "inline-grid size-9 place-items-center rounded-md text-fg-muted transition-colors duration-(--sb-duration-hover) ease-hover hover:bg-hover hover:text-fg",
        coarseTarget,
        focusRing,
        className,
      )}
      {...props}
    >
      <MenuIcon />
    </button>
  );
}

/** Convenience state for apps that do not need to control the sidebar elsewhere. */
export function useSidebarState(initialCollapsed = false) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [open, setOpen] = useState(false);
  return { collapsed, setCollapsed, open, setOpen };
}
