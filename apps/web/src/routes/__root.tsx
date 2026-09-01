import { HeadContent, Outlet, Scripts, createRootRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { AccountProvider, useAccount } from "../dashboard-data";
import "../styles.css";

export const Route = createRootRoute({ component: Root });

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
  return <Outlet />;
}

function Root() {
  return <html lang="en" suppressHydrationWarning><head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="theme-color" content="#0a0a0a" /><script dangerouslySetInnerHTML={{ __html: "document.documentElement.dataset.theme=localStorage.getItem('sproutboat-theme')||'dark'" }} /><HeadContent /></head><body><a className="skip-link" href="#content">Skip to content</a><AccountProvider><AuthGate /></AccountProvider><Scripts /></body></html>;
}
