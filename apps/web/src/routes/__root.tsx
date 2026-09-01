import { HeadContent, Outlet, Scripts, createRootRoute, redirect } from "@tanstack/react-router";
import "../styles.css";

export type Account = {
  profile?: { username?: string };
  isAdmin?: boolean;
  user?: { name?: string | null; email?: string; image?: string | null };
};

async function loadAccount(): Promise<Account | undefined> {
  try {
    const response = await fetch("/api/account", { credentials: "include" });
    if (!response.ok) return undefined;
    // SAFETY: /api/account returns the authenticated account contract on successful responses.
    return await response.json() as Account;
  } catch {
    return undefined;
  }
}

export const Route = createRootRoute({
  // Browser-only auth gate. This is an SPA: `_shell.html` is prerendered at
  // build time with no API reachable, so gating during prerender would bake a
  // logged-out state (the /login title + account:undefined) into the single
  // static file `try_files` serves for every route — every hard reload would
  // show /login until a client-side nav re-checked. Prerender a neutral shell;
  // the browser re-runs this against the live session.
  beforeLoad: async ({ location }: { location: { pathname: string } }) => {
    if (import.meta.env.SSR) return { account: undefined };
    const account = await loadAccount();
    if (!account && location.pathname !== "/login") throw redirect({ to: "/login", search: (previous) => previous });
    if (account && location.pathname === "/login") throw redirect({ to: "/" });
    return { account };
  },
  loader: ({ context }) => context.account,
  component: Root,
});

function Root() {
  return <html lang="en" suppressHydrationWarning><head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="theme-color" content="#0a0a0a" /><script dangerouslySetInnerHTML={{ __html: "document.documentElement.dataset.theme=localStorage.getItem('sproutboat-theme')||'dark'" }} /><HeadContent /></head><body><a className="skip-link" href="#content">Skip to content</a><Outlet /><Scripts /></body></html>;
}
