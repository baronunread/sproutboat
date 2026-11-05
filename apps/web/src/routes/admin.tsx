import { PageHeader } from "@sproutboat/ikada";
import { createFileRoute, Navigate, Outlet } from "@tanstack/react-router";
import { useAccount } from "../dashboard-data";
import { RouteTabs } from "../route-tabs";

export const Route = createFileRoute("/admin")({
  component: AdminLayout,
  head: () => ({ meta: [{ title: "Admin · Sproutboat" }] }),
});

function AdminLayout() {
  const { account, state } = useAccount();
  if (state === "loading") return null;
  if (!account?.isAdmin) return <Navigate to="/" />;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Admin"
        description="This box's status, its accounts and its backups."
        tabs={
          <RouteTabs
            label="Admin sections"
            tabs={[
              { to: "/admin", label: "System", exact: true },
              { to: "/admin/users", label: "Users" },
              { to: "/admin/backups", label: "Backups" },
            ]}
          />
        }
      />
      <Outlet />
    </div>
  );
}
