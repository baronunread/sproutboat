import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { Shell } from "../components";

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
  head: () => ({ meta: [{ title: "Settings · Sproutboat" }] }),
});

const activeProps = { "aria-current": "page" as const };

function SettingsLayout() {
  return (
    <Shell>
      <section className="page-heading">
        <div><h1>Settings</h1><p>Your account, the credentials that reach it, and what this box allows.</p></div>
      </section>
      <nav className="section-nav" aria-label="Settings sections">
        <Link to="/settings" activeOptions={{ exact: true }} activeProps={activeProps} className="section-tab">General</Link>
        <Link to="/settings/tokens" activeProps={activeProps} className="section-tab">API tokens</Link>
        <Link to="/settings/usage" activeProps={activeProps} className="section-tab">Usage &amp; limits</Link>
      </nav>
      <Outlet />
    </Shell>
  );
}
