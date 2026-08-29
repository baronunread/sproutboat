import { HeadContent, Outlet, Scripts, createRootRoute, redirect } from "@tanstack/react-router";
import "../styles.css";

export type Account = {
  profile?: { username?: string };
  isAdmin?: boolean;
  user?: { name?: string | null; email?: string; image?: string | null };
};

async function loadAccount({ serverContext }: { serverContext?: { request: Request } }): Promise<Account | undefined> {
  try {
    const request = serverContext?.request;
    let target: URL | string = "/api/account";
    if (request) {
      const url = new URL("/api/account", request.url);
      // Behind a TLS terminator (portless in dev, the edge proxy in prod) the
      // internal request scheme is http; hitting it triggers a 302 to https that
      // drops the forwarded Cookie. Talk to the public origin over https.
      if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") url.protocol = "https:";
      target = url;
    }
    const response = await fetch(target, {
      credentials: "include",
      headers: request ? { cookie: request.headers.get("cookie") ?? "" } : undefined,
    });
    if (!response.ok) return undefined;
    // SAFETY: /api/account returns the authenticated account contract on successful responses.
    return await response.json() as Account;
  } catch {
    return undefined;
  }
}

export const Route = createRootRoute({
  // Gate every route: no session -> straight to /login, on the server render too.
  beforeLoad: async ({ location, serverContext }: { location: { pathname: string }; serverContext?: { request: Request } }) => {
    const account = await loadAccount({ serverContext });
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
