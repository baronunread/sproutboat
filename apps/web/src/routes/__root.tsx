import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import "../styles.css";

export const Route = createRootRoute({
  component: Root,
});

function Root() {
  return <html lang="en" suppressHydrationWarning><head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="theme-color" content="#0a0a0a" /><script dangerouslySetInnerHTML={{ __html: "document.documentElement.dataset.theme=localStorage.getItem('sproutboat-theme')||'dark'" }} /><HeadContent /></head><body><a className="skip-link" href="#content">Skip to content</a><Outlet /><Scripts /></body></html>;
}
