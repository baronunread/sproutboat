import { createFileRoute, Link, Navigate, Outlet } from "@tanstack/react-router";
import { Shell } from "../components";
import { useAccount } from "../dashboard-data";

export const Route = createFileRoute("/admin")({
  component: AdminLayout,
  head: () => ({ meta: [{ title: "Admin · Sproutboat" }] }),
});

const activeProps = { "aria-current": "page" as const };

function AdminLayout() {
  const { account, state } = useAccount();
  if (state === "loading") return null;
  if (!account?.isAdmin) return <Navigate to="/" />;
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
