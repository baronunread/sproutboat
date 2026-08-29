import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";
import { Shell } from "../components";

export const Route = createFileRoute("/admin")({
  beforeLoad: ({ context }: { context: { account?: { isAdmin?: boolean } } }) => {
    if (!context.account?.isAdmin) throw redirect({ to: "/" });
  },
  component: AdminLayout,
  head: () => ({ meta: [{ title: "Admin · Sproutboat" }] }),
});

const activeProps = { "aria-current": "page" as const };

function AdminLayout() {
  return (
    <Shell>
      <section className="page-heading">
        <div><h1>Admin</h1><p>Platform-wide status and account administration.</p></div>
      </section>
      <nav className="section-nav" aria-label="Admin sections">
        <Link to="/admin" activeOptions={{ exact: true }} activeProps={activeProps} className="section-tab">Overview</Link>
        <Link to="/admin/users" activeProps={activeProps} className="section-tab">Users</Link>
        <Link to="/admin/backups" activeProps={activeProps} className="section-tab">Backups</Link>
      </nav>
      <Outlet />
    </Shell>
  );
}
