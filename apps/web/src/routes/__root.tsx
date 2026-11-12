import { HeadContent, Outlet, Scripts, createRootRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { ToastProvider, TooltipProvider } from "@sproutboat/ikada";
import { AccountProvider, useAccount } from "../dashboard-data";
import { Shell } from "../shell";
import { THEME_BOOT } from "../theme";
import "../app.css";

export const Route = createRootRoute({ component: Root });

/**
 * Applied before first paint so the chrome renders in its stored state instead
 * of flashing the default and correcting after hydration. Same trick the theme
 * has always used; the nav rail joins it because collapsing it moves layout.
 * A phone never shows the rail (the sidebar is a drawer there), so the stored
 * choice is the only input.
 */
const BOOT = `
${THEME_BOOT}
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
  // mounted. /login and /cli-authorize are the two screens with no shell
  // around them — the latter is a device-flow confirmation, not a dashboard
  // view, and the nav rail would only distract from reading it.
  if (pathname === "/login" || pathname === "/cli-authorize") return <Outlet />;
  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}

function Root() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#1a1d24" />
        {/* The Afloat mark. Served from apps/web/public. */}
        <link rel="icon" href="/favicon.ico" sizes="48x48" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <script dangerouslySetInnerHTML={{ __html: BOOT }} />
        <HeadContent />
      </head>
      <body>
        <a
          className="fixed top-0 left-4 z-(--sb-z-toast) -translate-y-[110%] rounded-b-md bg-brand px-4 py-3 font-semibold text-on-brand focus:translate-y-0"
          href="#content"
        >
          Skip to content
        </a>
        <TooltipProvider>
          <ToastProvider>
            <AccountProvider>
              <AuthGate />
            </AccountProvider>
          </ToastProvider>
        </TooltipProvider>
        <Scripts />
      </body>
    </html>
  );
}
