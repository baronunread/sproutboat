import { PageTab, PageTabs } from "@sproutboat/ikada";
import { Link as RouterLink, useRouterState } from "@tanstack/react-router";
import type { LinkProps } from "@tanstack/react-router";

export type RouteTab = { to: LinkProps["to"]; label: string; exact?: boolean };

/** Section tabs for a layout route: the current one is whichever path the router is on. */
export function RouteTabs({ label, tabs }: { label: string; tabs: readonly RouteTab[] }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <PageTabs label={label}>
      {tabs.map((tab) => {
        const to = String(tab.to);
        const current = tab.exact ? pathname === to : pathname === to || pathname.startsWith(`${to}/`);
        return (
          <PageTab
            key={to}
            current={current}
            render={<RouterLink to={tab.to} activeOptions={{ exact: tab.exact ?? false }} />}
          >
            {tab.label}
          </PageTab>
        );
      })}
    </PageTabs>
  );
}
