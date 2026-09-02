import { HeadContent, Outlet, Scripts, createRootRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { Shell } from "../components";
import { AccountProvider, useAccount } from "../dashboard-data";
import "../styles.css";

export const Route = createRootRoute({ component: Root });

/**
 * Applied before first paint so the chrome renders in its stored state instead
 * of flashing the default and correcting after hydration. Same trick the theme
 * has always used; the nav rail joins it because collapsing it moves layout.
 */
const BOOT = `
document.documentElement.dataset.theme = localStorage.getItem('sproutboat-theme') || 'dark';
document.documentElement.dataset.nav = localStorage.getItem('sproutboat-nav') || 'expanded';
`;

// Browser-only auth gate. This is a prerendered SPA: `_shell.html` is built with
// the API unreachable, so gating in a router loader/beforeLoad would bake a
// logged-out state into the one static file served for every route. `useAccount`
// fetches the real session client-side after hydration; this redirects once it
// resolves.
function AuthGate() {
  const { state } = useAccount();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  useEffect(() => {
    if (state === "anon" && pathname !== "/login") void navigate({ to: "/login", search: (previous) => previous });
    if (state === "authed" && pathname === "/login") void navigate({ to: "/" });
  }, [state, pathname, navigate]);

  // The shell lives here, above the router's outlet, so it mounts once for the
  // session. Rendering it per route unmounted the sidebar on every navigation:
  // the nav groups and the rail re-initialised from storage each time, which is
  // the flicker, and a reload had no chrome at all until the page component
  // mounted. /login is the one screen with no shell around it.
  if (pathname === "/login") return <Outlet />;
  return <Shell><Outlet /></Shell>;
}

function Root() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#0a0a0a" />
        <script dangerouslySetInnerHTML={{ __html: BOOT }} />
        <HeadContent />
      </head>
      <body>
        <a className="skip-link" href="#content">Skip to content</a>
        <AccountProvider><AuthGate /></AccountProvider>
        <Scripts />
      </body>
    </html>
  );
}
