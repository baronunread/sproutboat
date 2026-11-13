import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ActivityIcon,
  Avatar,
  Badge,
  Button,
  CommandPalette,
  DatabaseIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  FolderIcon,
  HomeIcon,
  InboxIcon,
  Kbd,
  KeyIcon,
  LogOutIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  Sidebar,
  SidebarFooter,
  SidebarHeader,
  SidebarItem,
  SidebarNav,
  SidebarToggle,
  SidebarTrigger,
  UserIcon,
  cn,
  shortcutLabel,
  useCommandPaletteShortcut,
  useIsDesktop,
} from "@sproutboat/ikada";
import type { PaletteGroup, PaletteItem } from "@sproutboat/ikada";
import { useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { useAccount, useJson } from "./dashboard-data";
import type { Overview } from "./dashboard-data";
import { isTheme, setTheme, subscribeTheme, themePref, themePrefOnServer } from "./theme-store";

/** The Sproutboat mark ("Afloat"): two leaves cut by a waterline, the bases forming a hull. Same geometry as favicon.svg.
 *  #17803F on light surfaces, #5BD97A on dark (ikada's `dark:` variant); the wordmark next to it stays foreground. */
export function SproutboatMark({ className }: { className?: string }) {
  return (
    <svg
      className={cn("size-6 shrink-0 text-[#17803F] dark:text-[#5BD97A]", className)}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M1.92 15A8.4 8.4 0 0 1 2.8 8.4A11 11 0 0 1 10.73 15ZM11.36 15A16 16 0 0 1 20.8 3.2A11.5 11.5 0 0 1 21.28 15ZM11.4 21A8.4 8.4 0 0 1 2.51 16.5L11.23 16.5A11 11 0 0 1 11.4 21ZM11.4 21A16 16 0 0 1 11.16 16.5L20.31 16.5A11.5 11.5 0 0 1 11.4 21ZM11.4 21L11.23 16.5L11.16 16.5Z" />
    </svg>
  );
}

async function logout() {
  await fetch("/api/auth/sign-out", { method: "POST", credentials: "include" });
  location.assign("/login");
}

/* ---------------------------------------------------------------------------
 * Rail state
 *
 * The collapsed flag lives on <html>, stamped by the boot script in __root.tsx before first
 * paint, and in localStorage under `sproutboat-nav`. React reads it during render through
 * useSyncExternalStore with a server snapshot, so hydration still matches and the toggle
 * never claims the wrong state on the first frame.
 * ------------------------------------------------------------------------- */
const navListeners = new Set<() => void>();

function subscribeNav(listener: () => void) {
  navListeners.add(listener);
  return () => {
    navListeners.delete(listener);
  };
}

const navCollapsed = () => document.documentElement.dataset.nav === "collapsed";

/** The prerendered shell is built with no reader, so it always renders expanded. */
const navCollapsedOnServer = () => false;

function setNavCollapsed(next: boolean) {
  document.documentElement.dataset.nav = next ? "collapsed" : "expanded";
  localStorage.setItem("sproutboat-nav", next ? "collapsed" : "expanded");
  for (const listener of navListeners) listener();
}

/* ---------------------------------------------------------------------------
 * Navigation
 * ------------------------------------------------------------------------- */
const ROUTES = [
  { id: "overview", to: "/", label: "Overview", exact: true, icon: <HomeIcon /> },
  { id: "projects", to: "/projects", label: "Sprouts", icon: <FolderIcon /> },
  { id: "queues", to: "/queues", label: "Queues", icon: <InboxIcon /> },
  { id: "activity", to: "/activity", label: "Activity", icon: <ActivityIcon /> },
  { id: "kv", to: "/kv", label: "KV", icon: <KeyIcon /> },
  { id: "d1", to: "/d1", label: "D1", icon: <DatabaseIcon /> },
  { id: "r2", to: "/r2", label: "R2", icon: <DatabaseIcon /> },
  { id: "settings", to: "/settings", label: "Settings", icon: <SettingsIcon /> },
  { id: "profile", to: "/profile", label: "Profile", icon: <UserIcon /> },
  { id: "admin", to: "/admin", label: "Admin", icon: <ShieldIcon /> },
] as const;

type RouteId = (typeof ROUTES)[number]["id"];
const byId = (id: RouteId) => {
  const route = ROUTES.find((candidate) => candidate.id === id);
  if (!route) throw new Error(`unknown route ${id}`);
  return route;
};

const isCurrent = (pathname: string, route: (typeof ROUTES)[number]) =>
  "exact" in route ? pathname === route.to : pathname === route.to || pathname.startsWith(`${route.to}/`);

function NavLink({ id, pathname }: { id: RouteId; pathname: string }) {
  const route = byId(id);
  return (
    <SidebarItem render={<Link to={route.to} />} icon={route.icon} current={isCurrent(pathname, route)}>
      {route.label}
    </SidebarItem>
  );
}

/** A labelled group. In the icon rail the heading gives way to a thin rule so the icons stay grouped. */
function NavGroup({ label, rail, children }: { label: string; rail: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      {rail ? (
        <div aria-hidden="true" className="mx-2 my-2 h-px bg-hairline" />
      ) : (
        <p aria-hidden="true" className="px-2.5 pb-1 pt-4 text-xs font-semibold text-fg-muted">
          {label}
        </p>
      )}
      <SidebarNav label={label}>{children}</SidebarNav>
    </div>
  );
}

const PALETTE_PREFIXES = [{ scope: "sprout", label: "Sprouts" }];

/** `loaded` turns true the first time the palette opens: until then a page load pays nothing for the project list. */
function usePaletteGroups(loaded: boolean, isAdmin: boolean): PaletteGroup[] {
  const { data } = useJson<Overview>(loaded ? "/api/overview" : null);
  const pages: PaletteItem[] = ROUTES.flatMap((route) =>
    route.id === "admin" && !isAdmin
      ? []
      : [
          {
            id: `route:${route.id}`,
            label: route.label,
            hint: route.to,
            icon: route.icon,
            keywords: route.id === "projects" ? "projects sprouts deploy" : undefined,
          },
        ],
  );
  const projects: PaletteItem[] = (data?.projects ?? []).map((project) => ({
    id: `project:${project.name}`,
    label: project.name,
    hint: project.hostname,
    icon: <FolderIcon />,
    scope: "sprout",
  }));
  return [
    { id: "pages", label: "Pages", items: pages },
    { id: "projects", label: "Sprouts", items: projects },
  ];
}

const THEMES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

function AccountMenu() {
  const { account } = useAccount();
  const theme = useSyncExternalStore(subscribeTheme, themePref, themePrefOnServer);
  const username = account?.profile?.username;
  const displayName = username || account?.user?.name || "account";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Open account menu"
        className="inline-grid rounded-lg outline-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <Avatar name={displayName} src={account?.user?.image} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {username ? (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Signed in as</DropdownMenuLabel>
              <p className="truncate px-2.5 pb-1.5 text-base font-semibold">{username}</p>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link to="/profile" />}>Profile</DropdownMenuItem>
            <DropdownMenuItem render={<Link to="/settings" />}>Settings</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Theme</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={theme}
                onValueChange={(next) => {
                  const value = String(next);
                  if (isTheme(value)) setTheme(value);
                }}
              >
                {THEMES.map((option) => (
                  <DropdownMenuRadioItem key={option.value} value={option.value}>
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void logout()}>
              <LogOutIcon />
              Log out
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Account</DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuItem render={<Link to="/login" />}>Sign in</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const { account } = useAccount();
  const isDesktop = useIsDesktop();
  const collapsed = useSyncExternalStore(subscribeNav, navCollapsed, navCollapsedOnServer);
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [paletteUsed, setPaletteUsed] = useState(false);
  const isAdmin = Boolean(account?.isAdmin);
  const groups = usePaletteGroups(paletteUsed, isAdmin);
  const openPalette = (next: boolean) => {
    if (next) setPaletteUsed(true);
    setPalette(next);
  };
  useCommandPaletteShortcut(() => openPalette(!palette));
  const rail = collapsed && isDesktop;

  function onSelect(item: PaletteItem) {
    if (item.id.startsWith("project:")) {
      void navigate({ to: "/projects/$name", params: { name: item.id.slice("project:".length) } });
      return;
    }
    const route = ROUTES.find((candidate) => `route:${candidate.id}` === item.id);
    if (route) void navigate({ to: route.to });
  }

  return (
    <div className="flex min-h-dvh">
      <Sidebar
        data-shell-sidebar=""
        collapsed={collapsed}
        open={drawer}
        onOpenChange={setDrawer}
        drawerLabel="Navigation"
        className="md:sticky md:top-0 md:h-dvh"
      >
        <SidebarHeader className={cn("h-10 justify-between", rail && "justify-center")}>
          {rail ? null : (
            <Link
              to="/"
              className="inline-flex min-w-0 items-center gap-2 rounded-md px-1 text-md font-bold outline-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <SproutboatMark />
              <span className="truncate">sproutboat</span>
            </Link>
          )}
          <SidebarToggle collapsed={collapsed} onCollapsedChange={setNavCollapsed} />
        </SidebarHeader>
        <SidebarNav label="Overview">
          <NavLink id="overview" pathname={pathname} />
        </SidebarNav>
        <NavGroup label="Compute" rail={rail}>
          <NavLink id="projects" pathname={pathname} />
          <NavLink id="queues" pathname={pathname} />
          <NavLink id="activity" pathname={pathname} />
        </NavGroup>
        <NavGroup label="Storage" rail={rail}>
          <NavLink id="kv" pathname={pathname} />
          <NavLink id="d1" pathname={pathname} />
          <NavLink id="r2" pathname={pathname} />
        </NavGroup>
        <NavGroup label="Settings" rail={rail}>
          <NavLink id="settings" pathname={pathname} />
          {isAdmin ? <NavLink id="admin" pathname={pathname} /> : null}
        </NavGroup>
        <SidebarFooter className="text-xs text-fg-muted">
          {rail ? null : <span className="px-2.5">Sproutboat Community</span>}
        </SidebarFooter>
      </Sidebar>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-(--sb-z-sticky) flex h-14 items-center gap-3 bg-canvas/90 px-4 shadow-[inset_0_-1px_0_var(--sb-hairline)] backdrop-blur sm:px-8">
          <SidebarTrigger className="md:hidden" onClick={() => setDrawer(true)} />
          <Link to="/" className="inline-flex items-center gap-2 text-md font-bold md:hidden">
            <SproutboatMark />
            <span className="max-[400px]:sr-only">sproutboat</span>
          </Link>
          <div className="ms-auto flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              aria-label="Search"
              aria-keyshortcuts="Control+K Meta+K"
              onClick={() => openPalette(true)}
              className="gap-2"
            >
              <SearchIcon />
              <span className="max-sm:sr-only">Search</span>
              <Kbd className="max-sm:hidden">{shortcutLabel()}</Kbd>
            </Button>
            {isAdmin ? <Badge tone="info">Admin</Badge> : null}
            <AccountMenu />
          </div>
        </header>
        <main id="content" className="mx-auto w-full max-w-[1220px] grow px-5 pt-8 pb-16 sm:px-10 sm:pt-12 sm:pb-20">
          {children}
        </main>
        <footer className="mt-auto flex flex-wrap items-center justify-center gap-x-6 gap-y-2 px-5 py-5 text-center text-xs text-fg-muted shadow-[inset_0_1px_0_var(--sb-hairline)] sm:px-8">
          <span>Sproutboat Community</span>
          <span>© {new Date().getFullYear()} Sproutboat</span>
        </footer>
      </div>
      <CommandPalette
        open={palette}
        onOpenChange={openPalette}
        groups={groups}
        prefixes={PALETTE_PREFIXES}
        onSelect={onSelect}
        placeholder="Search pages and sprouts…"
      />
    </div>
  );
}
